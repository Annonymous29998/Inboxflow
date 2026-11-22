import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';
import { isPlatformOperator } from '../../services/email/workspace-residency.js';
import { mergeOperatorPulse } from '../../services/admin/operator-pulse.js';
import {
  mergeLicenseBind,
  mergeOperatorBind,
  parseTypedBindIp,
  bindIpMustMatchRequest,
  publicClientIp,
} from '../../services/admin/license-bind.js';

const campaignSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(160).optional(),
  status: z.string().max(32).optional(),
  sentCount: z.number().int().nonnegative().optional(),
  openedCount: z.number().int().nonnegative().optional(),
  updatedAt: z.string().max(40).optional(),
});

/** Summary only — no recipient lists, HTML, or SMTP secrets. */
export async function workspacePulseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/pulse', async (request, reply) => {
    try {
      if (isPlatformOperator({ role: request.user.role, email: request.user.email })) {
        throw new AppError(403, 'Operator mailer does not report into tenant totals');
      }
      const orgId = requireOrg(request.user.organizationId);
      const actor = await prisma.user.findUnique({
        where: { id: request.user.id },
        select: { firstName: true, lastName: true, email: true },
      });
      const userName = `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim() || request.user.email;
      const userEmail = actor?.email || request.user.email;
      const body = z
        .object({
          sending: z.number().int().nonnegative().max(100_000).optional(),
          campaignsSent: z.number().int().nonnegative().max(1_000_000).optional(),
          emailsSent: z.number().int().nonnegative().max(50_000_000).optional(),
          emailsFailed: z.number().int().nonnegative().max(50_000_000).optional(),
          recentCampaigns: z.array(campaignSchema).max(8).optional(),
        })
        .parse(request.body || {});

      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { sendSettings: true },
      });
      if (!org) throw new AppError(404, 'Workspace not found');

      const pulse = {
        lastSeenAt: new Date().toISOString(),
        sending: body.sending ?? 0,
        campaignsSent: body.campaignsSent ?? 0,
        emailsSent: body.emailsSent ?? 0,
        emailsFailed: body.emailsFailed ?? 0,
        recentCampaigns: (body.recentCampaigns || []).map((c) => ({
          id: c.id,
          name: c.name || 'Untitled',
          status: c.status || 'DRAFT',
          sentCount: c.sentCount || 0,
          openedCount: c.openedCount || 0,
          updatedAt: c.updatedAt || new Date().toISOString(),
          userName,
          userEmail,
        })),
      };

      await prisma.organization.update({
        where: { id: orgId },
        data: { sendSettings: mergeOperatorPulse(org.sendSettings, pulse) as object },
      });

      return reply.send({ ok: true, lastSeenAt: pulse.lastSeenAt });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Stamp this VPS IP on the local SQLite workspace so open/click pixels hit this machine. */
  app.post('/device-bind', async (request, reply) => {
    try {
      if (isPlatformOperator({ role: request.user.role, email: request.user.email })) {
        throw new AppError(403, 'Operator tracking stays on Lightsail');
      }
      const orgId = requireOrg(request.user.organizationId);
      const body = z.object({ boundIp: z.string().min(3).max(64) }).parse(request.body);
      const boundIp = parseTypedBindIp(body.boundIp);
      if (!boundIp) throw new AppError(400, 'Enter the public IP of this RDP / Windows VPS.');
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { sendSettings: true },
      });
      if (!org) throw new AppError(404, 'Workspace not found');
      await prisma.organization.update({
        where: { id: orgId },
        data: {
          sendSettings: mergeLicenseBind(org.sendSettings, {
            boundIp,
            boundAt: new Date().toISOString(),
          }) as object,
        },
      });
      process.env.BOUND_IP = boundIp;
      return reply.send({ ok: true, boundIp });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Operator Settings: Bind PC on this RDP/VPS, or return send to Lightsail. */
  app.post('/operator-bind', async (request, reply) => {
    try {
      if (!isPlatformOperator({ role: request.user.role, email: request.user.email })) {
        throw new AppError(403, 'Only the operator can toggle Bind PC here');
      }
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          enabled: z.boolean(),
          boundIp: z.string().min(1).max(64).optional(),
        })
        .parse(request.body || {});
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { sendSettings: true },
      });
      if (!org) throw new AppError(404, 'Workspace not found');

      if (!body.enabled) {
        await prisma.organization.update({
          where: { id: orgId },
          data: { sendSettings: mergeOperatorBind(org.sendSettings, { enabled: false }) as object },
        });
        const accessToken = await app.jwt.sign(
          {
            sub: request.user.id,
            email: request.user.email,
            role: request.user.role,
            organizationId: request.user.organizationId,
            workspaceLocal: false,
          },
          { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
        );
        return reply.send({ ok: true, enabled: false, boundIp: null, accessToken });
      }

      const boundIp = parseTypedBindIp(String(body.boundIp || ''));
      if (!boundIp) throw new AppError(400, 'Enter the public IP of this RDP / Windows VPS.');
      const mismatch = bindIpMustMatchRequest(
        boundIp,
        publicClientIp({ ip: request.ip, headers: request.headers as Record<string, unknown> }),
      );
      if (mismatch) throw new AppError(403, mismatch);

      await prisma.organization.update({
        where: { id: orgId },
        data: {
          sendSettings: mergeOperatorBind(org.sendSettings, {
            enabled: true,
            boundIp,
            boundAt: new Date().toISOString(),
          }) as object,
        },
      });
      process.env.BOUND_IP = boundIp;
      const accessToken = await app.jwt.sign(
        {
          sub: request.user.id,
          email: request.user.email,
          role: request.user.role,
          organizationId: request.user.organizationId,
          workspaceLocal: true,
        },
        { expiresIn: env.JWT_ACCESS_EXPIRES_IN },
      );
      return reply.send({ ok: true, enabled: true, boundIp, accessToken });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
