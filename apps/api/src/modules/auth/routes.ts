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
  email: z.string().email(),
  password: z.string(),
  totpCode: z.string().optional(),
});

function cookieSecure(): boolean {
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
  const accessToken = await app.jwt.sign(
    { sub: user.id, email: user.email, role: user.role, organizationId: user.organizationId },
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
        html: `<p>Hi ${user.firstName},</p><p>Verify your email:</p><p><a href="${env.APP_URL}/verify-email?token=${verifyToken}">Verify Email</a></p>`,
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
      const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (!user) throw new AppError(401, 'Invalid credentials');
      if (user.status === 'SUSPENDED') throw new AppError(403, 'Account suspended');

      const valid = await bcrypt.compare(body.password, user.passwordHash);
      if (!valid) throw new AppError(401, 'Invalid credentials');

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
        },
        ...tokens,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

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
          html: `<p>Reset your password:</p><p><a href="${env.APP_URL}/reset-password?token=${token}">Reset Password</a></p><p>This link expires in 1 hour.</p>`,
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
          organization: { select: { id: true, name: true, slug: true, physicalAddress: true } },
        },
      });
      return reply.send({ user });
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
