import type { FastifyInstance, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError, sendError } from '../../utils/errors.js';
import { generateToken, hashToken, slugify } from '../../utils/crypto.js';
import { authenticate } from '../../middleware/auth.js';
import { sendTransactionalEmail } from '../../services/email/transactional.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  organizationName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().min(1),
  password: z.string(),
  totpCode: z.string().optional(),
});

function loginCandidates(ident: string): string[] {
  const lower = ident.trim().toLowerCase();
  if (!lower) return [];
  if (lower.includes('@')) return [lower];
  return [lower, `${lower}@inboxflow.io`, `${lower}@users.inboxflow.io`];
}

function licenseEndsAt(sub: { currentPeriodEnd: Date } | null | undefined) {
  return sub?.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null;
}

function cookieSecure(): boolean {
  if (process.env.INBOXFLOW_DESKTOP === '1') return false;
  if (env.COOKIE_SECURE !== undefined) return env.COOKIE_SECURE;
  return env.NODE_ENV === 'production';
}

function setAuthCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string; expiresAt: Date },
) {
  const secure = cookieSecure();
  reply.setCookie('access_token', tokens.accessToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 15,
  });
  reply.setCookie('refresh_token', tokens.refreshToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 60 * 60 * 24 * 7,
  });
}

function clearAuthCookies(reply: FastifyReply) {
  reply.clearCookie('access_token', { path: '/' });
  reply.clearCookie('refresh_token', { path: '/' });
}

async function createTokens(app: FastifyInstance, user: { id: string; email: string; role: string; organizationId: string | null }, meta: { userAgent?: string; ip?: string }) {
  let workspaceLocal = false;
  if (user.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { sendSettings: true },
    });
    const { orgKeepsWorkspaceOnDevice } = await import('../../services/email/workspace-residency.js');
    workspaceLocal = orgKeepsWorkspaceOnDevice({
      sendSettings: org?.sendSettings,
      role: user.role,
      email: user.email,
    });
  }
  const accessToken = await app.jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      workspaceLocal,
    },
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
  );
  const refreshToken = generateToken(48);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      userId: user.id,
      refreshToken: hashToken(refreshToken),
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    },
  });
  return { accessToken, refreshToken, expiresAt };
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/register',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
    try {
      if (!env.ALLOW_PUBLIC_REGISTER) {
        throw new AppError(403, 'Public registration is disabled');
      }
      const body = registerSchema.parse(request.body);
      const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (existing) throw new AppError(409, 'Email already registered');

      const passwordHash = await bcrypt.hash(body.password, 12);
      const baseSlug = slugify(body.organizationName);
      let slug = baseSlug;
      let i = 1;
      while (await prisma.organization.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${i++}`;
      }

      const plan = await prisma.plan.findFirst({ where: { slug: 'starter' } });

      const org = await prisma.organization.create({
        data: {
          name: body.organizationName,
          slug,
          users: {
            create: {
              email: body.email.toLowerCase(),
              passwordHash,
              firstName: body.firstName,
              lastName: body.lastName,
              role: 'ADMIN',
            },
          },
          ...(plan
            ? {
                subscription: {
                  create: {
                    planId: plan.id,
                    status: 'TRIALING',
                    currentPeriodStart: new Date(),
                    currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                  },
                },
              }
            : {}),
        },
        include: { users: true },
      });

      const user = org.users[0];
      const verifyToken = generateToken(32);
      await prisma.passwordReset.create({
        data: {
          userId: user.id,
          token: `verify_${hashToken(verifyToken)}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });

      await sendTransactionalEmail({
        to: user.email,
        subject: 'Verify your Inbox Flow account',
        html: `<p>Hi ${user.firstName},</p><p>Verify your email:</p><p><a href="${env.APP_URL || 'http://localhost:5173'}/verify-email?token=${verifyToken}">Verify Email</a></p>`,
      });

      const tokens = await createTokens(app, user, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      setAuthCookies(reply, tokens);

      return reply.status(201).send({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          organizationId: org.id,
          status: user.status,
        },
        ...tokens,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post(
    '/login',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
    try {
      const body = loginSchema.parse(request.body);
      const user = await prisma.user.findFirst({
        where: { email: { in: loginCandidates(body.email) } },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              physicalAddress: true,
              sendSettings: true,
              subscription: { select: { status: true, currentPeriodEnd: true } },
            },
          },
        },
      });
      if (!user) throw new AppError(401, 'Invalid credentials');
      if (user.status === 'SUSPENDED') throw new AppError(403, 'Account deactivated');
      if (user.role === 'USER') {
        const sub = user.organization?.subscription;
        const ended = !sub || sub.status === 'EXPIRED' || sub.status === 'CANCELLED' || new Date(sub.currentPeriodEnd).getTime() <= Date.now();
        if (ended) throw new AppError(403, 'Subscription ended. Ask your admin to renew.');
      }

      const valid = await bcrypt.compare(body.password, user.passwordHash);
      if (!valid) throw new AppError(401, 'Invalid credentials');

      if (user.role === 'USER') {
        const { licenseBindBlocked, publicClientIp } = await import('../../services/admin/license-bind.js');
        const blocked = licenseBindBlocked(
          user.organization?.sendSettings,
          publicClientIp({ ip: request.ip }),
        );
        if (blocked) throw new AppError(403, blocked);
      }

      if (user.twoFactorEnabled) {
        if (!body.totpCode) {
          return reply.send({ requires2FA: true });
        }
        const ok = authenticator.verify({ token: body.totpCode, secret: user.twoFactorSecret! });
        if (!ok) throw new AppError(401, 'Invalid 2FA code');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const tokens = await createTokens(app, user, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      setAuthCookies(reply, tokens);

      const { orgAllowsDirectSmtp } = await import('../../services/email/smtp-outbound.js');
      const { orgKeepsWorkspaceOnDevice } = await import('../../services/email/workspace-residency.js');
      const smtpAllowDirect = orgAllowsDirectSmtp({
        sendSettings: user.organization?.sendSettings,
        role: user.role,
        email: user.email,
      });
      const workspaceLocal = orgKeepsWorkspaceOnDevice({
        sendSettings: user.organization?.sendSettings,
        role: user.role,
        email: user.email,
      });

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          organizationId: user.organizationId,
          status: user.status,
          twoFactorEnabled: user.twoFactorEnabled,
          organization: user.organization
            ? {
                id: user.organization.id,
                name: user.organization.name,
                slug: user.organization.slug,
                physicalAddress: user.organization.physicalAddress ?? undefined,
              }
            : undefined,
          smtpAllowDirect,
          workspaceLocal,
          boundIp: (await import('../../services/admin/license-bind.js')).readLicenseBind(
            user.organization?.sendSettings,
          )?.boundIp ?? null,
          licenseEndsAt: licenseEndsAt(user.organization?.subscription),
        },
        ...tokens,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/bind-ip', async (request, reply) => {
    const { publicClientIp } = await import('../../services/admin/license-bind.js');
    return reply.send({
      ip: publicClientIp({ ip: request.ip, headers: request.headers as Record<string, unknown> }),
    });
  });

  /** EXE boot / admin tools: is this created user bound? Staff never bind for license. */
  app.post(
    '/bind-status',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      try {
        const body = z
          .object({
            username: z.string().min(1),
            licenseKey: z.string().min(1),
          })
          .parse(request.body);
        const { isPlatformOperator } = await import('../../services/email/workspace-residency.js');
        const { readLicenseBind } = await import('../../services/admin/license-bind.js');
        const user = await prisma.user.findFirst({
          where: { email: { in: loginCandidates(body.username) } },
          include: {
            organization: { select: { sendSettings: true } },
          },
        });
        if (!user) throw new AppError(401, 'Invalid username or license key');
        const valid = await bcrypt.compare(body.licenseKey, user.passwordHash);
        if (!valid) throw new AppError(401, 'Invalid username or license key');
        if (isPlatformOperator({ role: user.role, email: user.email })) {
          return reply.send({ staff: true, bound: true, boundIp: null, role: user.role });
        }
        const bind = readLicenseBind(user.organization?.sendSettings);
        return reply.send({
          staff: false,
          bound: Boolean(bind?.boundIp),
          boundIp: bind?.boundIp ?? null,
          role: user.role,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post(
    '/bind-ip',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '15 minutes' },
      },
    },
    async (request, reply) => {
      try {
        const body = z
          .object({
            username: z.string().min(1),
            licenseKey: z.string().min(1),
            boundIp: z.string().min(1),
          })
          .parse(request.body);
        const { isPlatformOperator } = await import('../../services/email/workspace-residency.js');
        const {
          mergeLicenseBind,
          parseTypedBindIp,
          readLicenseBind,
          ipsMatch,
          bindIpMustMatchRequest,
          publicClientIp,
        } = await import('../../services/admin/license-bind.js');

        const user = await prisma.user.findFirst({
          where: { email: { in: loginCandidates(body.username) } },
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                slug: true,
                physicalAddress: true,
                sendSettings: true,
                subscription: { select: { status: true, currentPeriodEnd: true } },
              },
            },
          },
        });
        if (!user) throw new AppError(401, 'Invalid username or license key');
        if (isPlatformOperator({ role: user.role, email: user.email })) {
          throw new AppError(403, 'Operator accounts do not use Bind PC');
        }
        if (user.status === 'SUSPENDED') throw new AppError(403, 'Account deactivated');
        const sub = user.organization?.subscription;
        const ended =
          !sub ||
          sub.status === 'EXPIRED' ||
          sub.status === 'CANCELLED' ||
          new Date(sub.currentPeriodEnd).getTime() <= Date.now();
        if (ended) throw new AppError(403, 'Subscription ended. Ask your admin to renew.');

        const valid = await bcrypt.compare(body.licenseKey, user.passwordHash);
        if (!valid) throw new AppError(401, 'Invalid username or license key');

        const boundIp = parseTypedBindIp(body.boundIp);
        if (!boundIp) {
          throw new AppError(400, 'Enter the public IP of this RDP / Windows VPS.');
        }
        const bindMismatch = bindIpMustMatchRequest(
          boundIp,
          publicClientIp({ ip: request.ip, headers: request.headers as Record<string, unknown> }),
        );
        if (bindMismatch) throw new AppError(403, bindMismatch);
        const already = readLicenseBind(user.organization?.sendSettings);
        if (already?.boundIp && !ipsMatch(already.boundIp, boundIp)) {
          throw new AppError(
            403,
            'This license is already activated on another PC. Ask admin to unbind it first.',
          );
        }

        const boundAt = new Date().toISOString();
        if (!user.organizationId) throw new AppError(400, 'Account has no workspace');
        await prisma.organization.update({
          where: { id: user.organizationId },
          data: {
            sendSettings: mergeLicenseBind(user.organization?.sendSettings, { boundIp, boundAt }) as object,
          },
        });
        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        const tokens = await createTokens(app, user, {
          userAgent: request.headers['user-agent'],
          ip: request.ip,
        });
        setAuthCookies(reply, tokens);

        const username = (user.firstName || user.email.split('@')[0] || user.email).trim();
        const { orgAllowsDirectSmtp } = await import('../../services/email/smtp-outbound.js');
        const { orgKeepsWorkspaceOnDevice } = await import('../../services/email/workspace-residency.js');
        const nextSettings = mergeLicenseBind(user.organization?.sendSettings, { boundIp, boundAt });
        return reply.send({
          success: true,
          activated: true,
          username,
          boundIp,
          validUntil: sub!.currentPeriodEnd.toISOString(),
          subscriptionStatus: sub!.status,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            organizationId: user.organizationId,
            status: user.status,
            smtpAllowDirect: orgAllowsDirectSmtp({
              sendSettings: nextSettings,
              role: user.role,
              email: user.email,
            }),
            workspaceLocal: orgKeepsWorkspaceOnDevice({
              sendSettings: nextSettings,
              role: user.role,
              email: user.email,
            }),
            boundIp,
            licenseEndsAt: licenseEndsAt(sub),
            organization: user.organization
              ? {
                  id: user.organization.id,
                  name: user.organization.name,
                  slug: user.organization.slug,
                  physicalAddress: user.organization.physicalAddress ?? undefined,
                }
              : undefined,
          },
          ...tokens,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post('/refresh', async (request, reply) => {
    try {
      const body = z
        .object({ refreshToken: z.string().optional() })
        .parse(request.body ?? {});
      const refreshToken =
        body.refreshToken ||
        (request.cookies?.refresh_token as string | undefined) ||
        (request.cookies?.refreshToken as string | undefined);
      if (!refreshToken) throw new AppError(401, 'Invalid refresh token');

      const session = await prisma.session.findUnique({
        where: { refreshToken: hashToken(refreshToken) },
        include: { user: true },
      });
      if (!session || session.revokedAt || session.expiresAt < new Date()) {
        throw new AppError(401, 'Invalid refresh token');
      }
      if (!session.user) {
        throw new AppError(401, 'User no longer exists');
      }

      await prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });

      const tokens = await createTokens(app, session.user, {
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      });

      setAuthCookies(reply, tokens);

      return reply.send(tokens);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/logout', async (request, reply) => {
    try {
      const body = z.object({ refreshToken: z.string().optional() }).parse(request.body ?? {});
      const refreshToken =
        body.refreshToken ||
        (request.cookies?.refresh_token as string | undefined) ||
        (request.cookies?.refreshToken as string | undefined);

      // Best-effort auth so we can revoke the right user's session
      try {
        await authenticate(request, reply);
      } catch {
        /* allow cookie clear even if access token expired */
      }

      if (refreshToken) {
        const where = request.user?.id
          ? { refreshToken: hashToken(refreshToken), userId: request.user.id }
          : { refreshToken: hashToken(refreshToken) };
        await prisma.session.updateMany({
          where,
          data: { revokedAt: new Date() },
        });
      }
      clearAuthCookies(reply);
      return reply.send({ success: true });
    } catch (error) {
      clearAuthCookies(reply);
      return sendError(reply, error);
    }
  });

  app.post('/forgot-password', async (request, reply) => {
    try {
      const body = z.object({ email: z.string().email() }).parse(request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      // Always return success to prevent enumeration
      if (user) {
        const token = generateToken(32);
        await prisma.passwordReset.create({
          data: {
            userId: user.id,
            token: hashToken(token),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          },
        });
        await sendTransactionalEmail({
          to: user.email,
          subject: 'Reset your Inbox Flow password',
          html: `<p>Reset your password:</p><p><a href="${env.APP_URL || 'http://localhost:5173'}/reset-password?token=${token}">Reset Password</a></p><p>This link expires in 1 hour.</p>`,
        });
      }
      return reply.send({ success: true, message: 'If that email exists, a reset link was sent.' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/reset-password', async (request, reply) => {
    try {
      const body = z.object({ token: z.string(), password: z.string().min(8) }).parse(request.body);
      const reset = await prisma.passwordReset.findUnique({
        where: { token: hashToken(body.token) },
      });
      if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
        throw new AppError(400, 'Invalid or expired token');
      }
      const passwordHash = await bcrypt.hash(body.password, 12);
      await prisma.$transaction([
        prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
        prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
        prisma.session.updateMany({
          where: { userId: reset.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/verify-email', async (request, reply) => {
    try {
      const body = z.object({ token: z.string() }).parse(request.body);
      const reset = await prisma.passwordReset.findUnique({
        where: { token: `verify_${hashToken(body.token)}` },
      });
      if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
        throw new AppError(400, 'Invalid or expired verification token');
      }
      await prisma.$transaction([
        prisma.user.update({
          where: { id: reset.userId },
          data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
        }),
        prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      ]);
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          twoFactorEnabled: true,
          avatarUrl: true,
          timezone: true,
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              physicalAddress: true,
              sendSettings: true,
              subscription: { select: { currentPeriodEnd: true } },
            },
          },
        },
      });
      if (!user) throw new AppError(404, 'User not found');
      const { orgAllowsDirectSmtp } = await import('../../services/email/smtp-outbound.js');
      const smtpAllowDirect = orgAllowsDirectSmtp({
        sendSettings: user.organization?.sendSettings,
        role: user.role,
        email: user.email,
      });
      const { orgKeepsWorkspaceOnDevice } = await import('../../services/email/workspace-residency.js');
      const workspaceLocal = orgKeepsWorkspaceOnDevice({
        sendSettings: user.organization?.sendSettings,
        role: user.role,
        email: user.email,
      });
      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          status: user.status,
          twoFactorEnabled: user.twoFactorEnabled,
          avatarUrl: user.avatarUrl,
          timezone: user.timezone,
          organizationId: user.organizationId,
          organization: user.organization
            ? {
                id: user.organization.id,
                name: user.organization.name,
                slug: user.organization.slug,
                physicalAddress: user.organization.physicalAddress,
              }
            : null,
          smtpAllowDirect,
          workspaceLocal,
          boundIp: (await import('../../services/admin/license-bind.js')).readLicenseBind(
            user.organization?.sendSettings,
          )?.boundIp ?? null,
          licenseEndsAt: licenseEndsAt(user.organization?.subscription),
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/sessions', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const sessions = await prisma.session.findMany({
        where: { userId: request.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send({ sessions });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/sessions/:id', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      await prisma.session.updateMany({
        where: { id, userId: request.user.id },
        data: { revokedAt: new Date() },
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/2fa/setup', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const secret = authenticator.generateSecret();
      await prisma.user.update({
        where: { id: request.user.id },
        data: { twoFactorSecret: secret },
      });
      const otpauth = authenticator.keyuri(request.user.email, env.APP_NAME, secret);
      const qrCode = await QRCode.toDataURL(otpauth);
      return reply.send({ secret, qrCode });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/2fa/enable', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ code: z.string() }).parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: request.user.id } });
      if (!user?.twoFactorSecret) throw new AppError(400, 'Run 2FA setup first');
      const ok = authenticator.verify({ token: body.code, secret: user.twoFactorSecret });
      if (!ok) throw new AppError(400, 'Invalid code');
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/2fa/disable', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const body = z.object({ code: z.string(), password: z.string() }).parse(request.body);
      const user = await prisma.user.findUnique({ where: { id: request.user.id } });
      if (!user) throw new AppError(404, 'User not found');
      const valid = await bcrypt.compare(body.password, user.passwordHash);
      if (!valid) throw new AppError(401, 'Invalid password');
      if (user.twoFactorEnabled) {
        const ok = authenticator.verify({ token: body.code, secret: user.twoFactorSecret! });
        if (!ok) throw new AppError(400, 'Invalid code');
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null },
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
