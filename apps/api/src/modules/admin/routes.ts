import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requireRole('SUPER_ADMIN', 'ADMIN'));

  app.get('/users', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const users = await prisma.user.findMany({
        where: request.user.role === 'SUPER_ADMIN' ? {} : { organizationId: orgId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          status: true,
          lastLoginAt: true,
          createdAt: true,
          organization: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send({ users });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({
        status: 'ok',
        database: 'up',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/audit-logs', async (request, reply) => {
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
                  mode: z.enum(['failover', 'round_robin', 'weighted']).optional(),
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
