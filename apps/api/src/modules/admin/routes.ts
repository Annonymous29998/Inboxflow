import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { slugify } from '../../utils/crypto.js';
import { orgKeepsWorkspaceOnDevice } from '../../services/email/workspace-residency.js';
import { mergeAdminNote, readAdminNote, readOperatorPulse, sumPulses } from '../../services/admin/operator-pulse.js';
import { clearLicenseBind, readLicenseBind } from '../../services/admin/license-bind.js';
import { readLicenseKey, writeLicenseKey } from '../../services/admin/license-key-record.js';

const TENANT_USER_WHERE = { role: 'USER' as const };

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const LICENSE_LOGIN_DOMAIN = 'inboxflow.io';

function generateLicenseKey(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

function addCalendarMonths(from: Date, months: number) {
  const d = new Date(from.getTime());
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0);
  return d;
}

function extendSubscriptionEnd(currentEnd: Date | null | undefined, months: number) {
  const now = new Date();
  const base = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  return addCalendarMonths(base, months);
}

function serializeSubscription(sub: { status: string; currentPeriodStart: Date; currentPeriodEnd: Date } | null | undefined) {
  if (!sub) return null;
  return {
    status: sub.status,
    currentPeriodStart: sub.currentPeriodStart.toISOString(),
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
    active: sub.status === 'ACTIVE' && sub.currentPeriodEnd.getTime() > Date.now(),
  };
}

function usernameToEmail(username: string): string {
  return `${username.toLowerCase()}@${LICENSE_LOGIN_DOMAIN}`;
}

function displayUsername(email: string, firstName?: string | null): string {
  const local = String(email || '').split('@')[0] || '';
  if (firstName && firstName.toLowerCase() === local.toLowerCase()) return firstName;
  return local || firstName || email;
}

function person(u: { firstName?: string | null; email?: string | null; username?: string | null }) {
  const username = u.username || displayUsername(u.email || '', u.firstName);
  return { username, name: username, email: u.email || '' };
}

async function listTenantRecentCampaigns(operatorOrgId: string) {
  const tenantUsers = await prisma.user.findMany({
    where: TENANT_USER_WHERE,
    select: {
      id: true,
      email: true,
      firstName: true,
      organizationId: true,
      organization: { select: { id: true, name: true, sendSettings: true } },
    },
  });
  const userByOrg = new Map<string, { firstName: string; email: string }>();
  for (const u of tenantUsers) {
    if (u.organizationId && !userByOrg.has(u.organizationId)) {
      userByOrg.set(u.organizationId, { firstName: u.firstName, email: u.email });
    }
  }
  const tenantOrgIds = [...userByOrg.keys()].filter((id) => id !== operatorOrgId);
  const fromPulse = tenantUsers.flatMap((u) => {
    const pulse = readOperatorPulse(u.organization?.sendSettings);
    const owner = person({ firstName: u.firstName, email: u.email });
    return pulse.recentCampaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      sentCount: c.sentCount,
      openedCount: c.openedCount,
      organization: { name: u.organization?.name || 'Workspace' },
      user: c.userName || c.userEmail ? person({ username: c.userName, email: c.userEmail || u.email }) : owner,
      updatedAt: c.updatedAt,
    }));
  });
  const fromCloud =
    tenantOrgIds.length === 0
      ? []
      : (
          await prisma.campaign.findMany({
            where: {
              organizationId: { in: tenantOrgIds },
              status: { in: ['SENDING', 'SENT', 'PAUSED', 'FAILED'] },
            },
            orderBy: { updatedAt: 'desc' },
            take: 24,
            select: {
              id: true,
              name: true,
              status: true,
              sentCount: true,
              openedCount: true,
              organizationId: true,
              updatedAt: true,
              createdBy: { select: { firstName: true, email: true, role: true } },
              organization: { select: { name: true } },
            },
          })
        )
          .filter((c) => c.createdBy?.role !== 'SUPER_ADMIN' && c.createdBy?.role !== 'ADMIN')
          .map((c) => {
            const owner = userByOrg.get(c.organizationId);
            const user = person(
              c.createdBy?.role === 'USER'
                ? { firstName: c.createdBy.firstName, email: c.createdBy.email }
                : { firstName: owner?.firstName, email: owner?.email },
            );
            return {
              id: c.id,
              name: c.name,
              status: c.status,
              sentCount: c.sentCount,
              openedCount: c.openedCount,
              organization: c.organization,
              user,
              updatedAt: c.updatedAt.toISOString(),
            };
          });
  const byId = new Map<string, (typeof fromPulse)[number]>();
  for (const row of [...fromPulse, ...fromCloud]) {
    if (row.user?.username) byId.set(row.id, row);
  }
  return [...byId.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 20);
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/users', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const users = await prisma.user.findMany({
        where: TENANT_USER_WHERE,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              sendSettings: true,
              subscription: {
                select: { status: true, currentPeriodStart: true, currentPeriodEnd: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send({
        users: users.map((u) => {
          const pulse = readOperatorPulse(u.organization?.sendSettings);
          const bind = readLicenseBind(u.organization?.sendSettings);
          const onDevice = orgKeepsWorkspaceOnDevice({
            sendSettings: u.organization?.sendSettings,
            role: u.role,
            email: u.email,
          });
          return {
            id: u.id,
            email: u.email,
            firstName: u.firstName,
            lastName: u.lastName,
            role: u.role,
            status: u.status,
            lastLoginAt: u.lastLoginAt,
            createdAt: u.createdAt,
            username: displayUsername(u.email, u.firstName),
            organization: u.organization ? { id: u.organization.id, name: u.organization.name } : null,
            subscription: serializeSubscription(u.organization?.subscription),
            adminNote: readAdminNote(u.organization?.sendSettings),
            boundIp: bind?.boundIp ?? null,
            boundAt: bind?.boundAt ?? null,
            licenseBound: Boolean(bind?.boundIp),
            licenseKey: readLicenseKey(u.organization?.sendSettings),
            onDevice,
            pulse: {
              lastSeenAt: pulse.lastSeenAt || null,
              sending: pulse.sending,
              campaignsSent: pulse.campaignsSent,
              emailsSent: pulse.emailsSent,
              emailsFailed: pulse.emailsFailed,
              recentCampaigns: pulse.recentCampaigns,
            },
          };
        }),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/users', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const body = z
        .object({
          username: z.string().regex(USERNAME_RE, 'Username must be 3–32 letters, numbers, dot, dash, or underscore').optional(),
          email: z.string().email().optional(),
          firstName: z.string().min(1).optional(),
          lastName: z.string().optional(),
          password: z.string().min(8).optional(),
          licenseKey: z.string().min(8).optional(),
          organizationName: z.string().min(1).optional(),
        })
        .parse(request.body);

      const username = (body.username || body.firstName || (body.email || '').split('@')[0] || '')
        .trim();
      if (!USERNAME_RE.test(username)) {
        throw new AppError(400, 'Choose a username (3–32 letters, numbers, dot, dash, or underscore)');
      }
      const email = (body.email || usernameToEmail(username)).toLowerCase().trim();
      const existing = await prisma.user.findFirst({
        where: { OR: [{ email }, { email: usernameToEmail(username) }] },
      });
      if (existing) throw new AppError(409, 'That username already has a login');

      const password = (body.licenseKey || body.password || '').trim() || generateLicenseKey();
      const passwordHash = await bcrypt.hash(password, 12);
      const orgName = (body.organizationName || username).trim();
      const baseSlug = slugify(orgName) || `user-${Date.now().toString(36)}`;
      let slug = baseSlug;
      let i = 1;
      while (await prisma.organization.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${i++}`;
      }

      const plan = (await prisma.plan.findFirst({ where: { slug: 'starter' } })) || (await prisma.plan.findFirst());
      const periodStart = new Date();
      const periodEnd = addCalendarMonths(periodStart, 1);
      const org = await prisma.organization.create({
        data: {
          name: orgName,
          slug,
          sendSettings: writeLicenseKey({ smtpAllowDirect: false, workspaceLocal: true }, password) as object,
          users: {
            create: {
              email,
              passwordHash,
              firstName: username,
              lastName: (body.lastName || '').trim(),
              role: 'USER',
              status: 'ACTIVE',
              emailVerifiedAt: new Date(),
            },
          },
          ...(plan
            ? {
                subscription: {
                  create: {
                    planId: plan.id,
                    status: 'ACTIVE',
                    currentPeriodStart: periodStart,
                    currentPeriodEnd: periodEnd,
                  },
                },
              }
            : {}),
        },
        include: { users: true, subscription: true },
      });
      const created = org.users[0]!;
      return reply.status(201).send({
        user: {
          id: created.id,
          email: created.email,
          username,
          firstName: created.firstName,
          lastName: created.lastName,
          role: created.role,
          status: created.status,
          organization: { id: org.id, name: org.name },
          subscription: serializeSubscription(org.subscription),
        },
        password,
        licenseKey: password,
        username,
        organizationName: org.name,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/users/:id', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const user = await prisma.user.findFirst({
        where: { id, role: 'USER' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              sendSettings: true,
              subscription: {
                select: { status: true, currentPeriodStart: true, currentPeriodEnd: true },
              },
            },
          },
          sessions: {
            orderBy: { createdAt: 'desc' },
            take: 24,
            select: {
              id: true,
              userAgent: true,
              ipAddress: true,
              createdAt: true,
              expiresAt: true,
              revokedAt: true,
            },
          },
        },
      });
      if (!user) throw new AppError(404, 'User not found');
      const pulse = readOperatorPulse(user.organization?.sendSettings);
      const bind = readLicenseBind(user.organization?.sendSettings);
      const onDevice = orgKeepsWorkspaceOnDevice({
        sendSettings: user.organization?.sendSettings,
        role: user.role,
        email: user.email,
      });
      const now = Date.now();
      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          username: displayUsername(user.email, user.firstName),
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          status: user.status,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
          organization: user.organization ? { id: user.organization.id, name: user.organization.name } : null,
          onDevice,
          boundIp: bind?.boundIp ?? null,
          boundAt: bind?.boundAt ?? null,
          licenseBound: Boolean(bind?.boundIp),
          licenseKey: readLicenseKey(user.organization?.sendSettings),
          adminNote: readAdminNote(user.organization?.sendSettings),
          subscription: serializeSubscription(user.organization?.subscription),
          pulse: {
            lastSeenAt: pulse.lastSeenAt || null,
            sending: pulse.sending,
            campaignsSent: pulse.campaignsSent,
            emailsSent: pulse.emailsSent,
            emailsFailed: pulse.emailsFailed,
          },
          sessions: user.sessions.map((s) => ({
            id: s.id,
            userAgent: s.userAgent || '',
            ipAddress: s.ipAddress || '',
            createdAt: s.createdAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
            current: !s.revokedAt && s.expiresAt.getTime() > now,
          })),
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/recent-campaigns', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const campaigns = await listTenantRecentCampaigns(request.user.organizationId || '');
      return reply.send({ campaigns });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/overview', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const operatorOrgId = request.user.organizationId || '';
      const tenantUsers = await prisma.user.findMany({
        where: TENANT_USER_WHERE,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          organizationId: true,
          organization: { select: { id: true, name: true, sendSettings: true } },
        },
      });

      const tenantOrgIds = [
        ...new Set(
          tenantUsers
            .map((u) => u.organizationId)
            .filter((id): id is string => Boolean(id) && id !== operatorOrgId),
        ),
      ];

      const orgs = await prisma.organization.findMany({
        where: { id: { in: tenantOrgIds } },
        select: { id: true, name: true, sendSettings: true },
      });
      const orgById = new Map(orgs.map((o) => [o.id, o]));

      const pulsedOrgIds: string[] = [];
      const cloudOrgIds: string[] = [];
      for (const id of tenantOrgIds) {
        const org = orgById.get(id);
        const pulse = readOperatorPulse(org?.sendSettings);
        if (
          pulse.lastSeenAt &&
          orgKeepsWorkspaceOnDevice({
            sendSettings: org?.sendSettings,
            role: 'USER',
          })
        ) {
          pulsedOrgIds.push(id);
        } else {
          cloudOrgIds.push(id);
        }
      }

      const [cloudSending, cloudSent, cloudSum, cloudRecent] = await Promise.all([
        cloudOrgIds.length
          ? prisma.campaign.count({ where: { organizationId: { in: cloudOrgIds }, status: 'SENDING' } })
          : Promise.resolve(0),
        cloudOrgIds.length
          ? prisma.campaign.count({ where: { organizationId: { in: cloudOrgIds }, status: 'SENT' } })
          : Promise.resolve(0),
        cloudOrgIds.length
          ? prisma.campaign.aggregate({
              where: { organizationId: { in: cloudOrgIds } },
              _sum: { sentCount: true, failedCount: true },
            })
          : Promise.resolve({ _sum: { sentCount: 0, failedCount: 0 } }),
        cloudOrgIds.length
          ? prisma.campaign.findMany({
              where: {
                organizationId: { in: cloudOrgIds },
                status: { in: ['SENDING', 'SENT', 'PAUSED', 'FAILED'] },
              },
              orderBy: { updatedAt: 'desc' },
              take: 24,
              select: {
                id: true,
                name: true,
                status: true,
                sentCount: true,
                openedCount: true,
                organizationId: true,
                createdBy: { select: { firstName: true, lastName: true, email: true, role: true } },
                organization: { select: { name: true } },
                updatedAt: true,
              },
            })
          : Promise.resolve([]),
      ]);

      const localPulses = pulsedOrgIds.map((id) => readOperatorPulse(orgById.get(id)?.sendSettings));
      const pulseSum = sumPulses(localPulses);

      const userByOrg = new Map<
        string,
        { firstName: string; lastName: string; email: string; username: string }
      >();
      for (const u of tenantUsers) {
        if (u.organizationId && !userByOrg.has(u.organizationId)) {
          userByOrg.set(u.organizationId, {
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            username: displayUsername(u.email, u.firstName),
          });
        }
      }

      function asUser(
        u?: { firstName?: string | null; lastName?: string | null; email?: string | null; username?: string | null } | null,
      ) {
        if (!u) return null;
        const username = u.username || displayUsername(u.email || '', u.firstName);
        return { username, name: username, email: u.email || '' };
      }

      const recentFromPulse = pulsedOrgIds.flatMap((id) => {
        const org = orgById.get(id);
        const owner = asUser(userByOrg.get(id));
        return readOperatorPulse(org?.sendSettings).recentCampaigns.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          sentCount: c.sentCount,
          openedCount: c.openedCount,
          organization: { name: org?.name || 'On-device workspace' },
          user:
            c.userName || c.userEmail
              ? {
                  username: c.userName || displayUsername(c.userEmail || '', null),
                  name: c.userName || c.userEmail || 'User',
                  email: c.userEmail || '',
                }
              : owner,
          updatedAt: c.updatedAt,
        }));
      });

      const recentFromCloud = cloudRecent.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        sentCount: c.sentCount,
        openedCount: c.openedCount,
        organization: c.organization,
        user:
          (c.createdBy && c.createdBy.role !== 'SUPER_ADMIN' && c.createdBy.role !== 'ADMIN'
            ? asUser(c.createdBy)
            : null) || asUser(userByOrg.get(c.organizationId)),
        updatedAt: c.updatedAt,
      }));

      const recentCampaigns = [...recentFromPulse, ...recentFromCloud]
        .filter((c) => Boolean(c.user?.email || c.user?.name))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 20);

      let database: 'up' | 'down' = 'up';
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        database = 'down';
      }

      return reply.send({
        health: { status: 'ok', database },
        stats: {
          users: tenantUsers.length,
          workspaces: tenantOrgIds.length,
          sending: cloudSending + pulseSum.sending,
          sent: cloudSent + pulseSum.campaignsSent,
          emailsSent: (cloudSum._sum.sentCount ?? 0) + pulseSum.emailsSent,
          emailsFailed: (cloudSum._sum.failedCount ?? 0) + pulseSum.emailsFailed,
        },
        scope: 'tenants',
        recentUsers: tenantUsers.slice(0, 8).map((u) => ({
          id: u.id,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          role: u.role,
          status: u.status,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
          organization: u.organization ? { name: u.organization.name } : null,
        })),
        recentCampaigns,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/users/:id', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
          addMonths: z.number().int().min(1).max(24).optional(),
          username: z.string().regex(USERNAME_RE).optional(),
          organizationName: z.string().min(1).max(80).optional(),
          adminNote: z.string().max(500).optional(),
          resetLicense: z.boolean().optional(),
          unbindLicense: z.boolean().optional(),
        })
        .parse(request.body);

      const target = await prisma.user.findFirst({
        where: { id, role: 'USER' },
        include: {
          organization: { include: { subscription: true } },
        },
      });
      if (!target) throw new AppError(404, 'User not found');
      if (target.id === request.user.id) throw new AppError(400, 'You cannot change your own account here');

      if (body.status) {
        await prisma.user.update({ where: { id }, data: { status: body.status } });
      }

      if (body.username) {
        const email = usernameToEmail(body.username);
        const clash = await prisma.user.findFirst({ where: { email, NOT: { id } } });
        if (clash) throw new AppError(409, 'That username already has a login');
        await prisma.user.update({
          where: { id },
          data: { firstName: body.username, email },
        });
      }

      if (body.organizationName && target.organizationId) {
        await prisma.organization.update({
          where: { id: target.organizationId },
          data: { name: body.organizationName.trim() },
        });
      }

      let licenseKey: string | undefined;
      if (body.resetLicense) {
        licenseKey = generateLicenseKey();
        const passwordHash = await bcrypt.hash(licenseKey, 12);
        await prisma.user.update({ where: { id }, data: { passwordHash } });
        await prisma.session.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
      }

      if ((body.resetLicense || body.unbindLicense) && target.organizationId) {
        const org = await prisma.organization.findUnique({
          where: { id: target.organizationId },
          select: { sendSettings: true },
        });
        let nextSettings = clearLicenseBind(org?.sendSettings);
        if (licenseKey) nextSettings = writeLicenseKey(nextSettings, licenseKey);
        await prisma.organization.update({
          where: { id: target.organizationId },
          data: { sendSettings: nextSettings as object },
        });
        await prisma.session.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
      }

      if (body.adminNote !== undefined && target.organizationId) {
        const org = await prisma.organization.findUnique({
          where: { id: target.organizationId },
          select: { sendSettings: true },
        });
        await prisma.organization.update({
          where: { id: target.organizationId },
          data: { sendSettings: mergeAdminNote(org?.sendSettings, body.adminNote) as object },
        });
      }

      if (body.addMonths) {
        const org = target.organization;
        if (!org) throw new AppError(400, 'User has no workspace');
        const plan = (await prisma.plan.findFirst({ where: { slug: 'starter' } })) || (await prisma.plan.findFirst());
        if (!plan) throw new AppError(400, 'No billing plan is configured');
        const nextEnd = extendSubscriptionEnd(org.subscription?.currentPeriodEnd, body.addMonths);
        const nextStart = org.subscription?.currentPeriodEnd && org.subscription.currentPeriodEnd.getTime() > Date.now()
          ? org.subscription.currentPeriodStart
          : new Date();
        if (org.subscription) {
          await prisma.subscription.update({
            where: { id: org.subscription.id },
            data: {
              status: 'ACTIVE',
              currentPeriodStart: nextStart,
              currentPeriodEnd: nextEnd,
              cancelledAt: null,
            },
          });
        } else {
          await prisma.subscription.create({
            data: {
              organizationId: org.id,
              planId: plan.id,
              status: 'ACTIVE',
              currentPeriodStart: nextStart,
              currentPeriodEnd: nextEnd,
            },
          });
        }
      }

      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          organization: {
            select: {
              id: true,
              name: true,
              subscription: { select: { status: true, currentPeriodStart: true, currentPeriodEnd: true } },
            },
          },
        },
      });
      return reply.send({
        licenseKey,
        user: user
          ? {
              ...user,
              username: displayUsername(user.email, user.firstName),
              subscription: serializeSubscription(user.organization?.subscription),
              adminNote: body.adminNote !== undefined ? body.adminNote : readAdminNote(target.organization?.sendSettings),
            }
          : null,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/users/:id', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      if (id === request.user.id) throw new AppError(400, 'You cannot delete your own account');
      const target = await prisma.user.findFirst({
        where: { id, role: 'USER' },
        select: { id: true, organizationId: true },
      });
      if (!target) throw new AppError(404, 'User not found');
      await prisma.$transaction(async (tx) => {
        await tx.template.updateMany({ where: { createdById: id }, data: { createdById: null } });
        await tx.user.delete({ where: { id } });
        if (!target.organizationId) return;
        const left = await tx.user.count({ where: { organizationId: target.organizationId } });
        if (left === 0) await tx.organization.delete({ where: { id: target.organizationId } });
      });
      return reply.send({ ok: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/health', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({
        status: 'ok',
        database: 'up',
        timestamp: new Date().toISOString(),
        features: {
          pulse: true,
          adminNote: true,
          resetLicense: true,
          subscriptions: true,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/audit-logs', { preHandler: requireRole('SUPER_ADMIN', 'ADMIN') }, async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const logs = await prisma.auditLog.findMany({
        where: request.user.role === 'SUPER_ADMIN' ? {} : { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return reply.send({ logs });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/organization', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          name: z.string().optional(),
          physicalAddress: z.string().optional(),
          website: z.string().optional(),
          sendSettings: z
            .object({
              smtpRotation: z
                .object({
                  enabled: z.boolean().optional(),
                  mode: z.enum(['failover', 'round_robin', 'weighted', 'performance']).optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .parse(request.body);

      const existing = await prisma.organization.findUnique({ where: { id: orgId } });
      const prev = (existing?.sendSettings || {}) as Record<string, unknown>;
      const nextSettings = body.sendSettings
        ? {
            ...prev,
            ...body.sendSettings,
            smtpRotation: {
              ...((prev.smtpRotation as object) || {}),
              ...(body.sendSettings.smtpRotation || {}),
            },
          }
        : undefined;

      const organization = await prisma.organization.update({
        where: { id: orgId },
        data: {
          name: body.name,
          physicalAddress: body.physicalAddress,
          website: body.website,
          ...(nextSettings ? { sendSettings: nextSettings as object } : {}),
        },
      });
      return reply.send({ organization });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/organization', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const organization = await prisma.organization.findUnique({ where: { id: orgId } });
      return reply.send({ organization });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
