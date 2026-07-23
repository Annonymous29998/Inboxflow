import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';

export async function systemLogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const q = request.query as {
        level?: string;
        category?: string;
        search?: string;
        limit?: string;
        before?: string;
      };
      const limit = Math.min(Number(q.limit || 200), 500);
      const where: Record<string, unknown> = { organizationId: orgId };
      if (q.level) where.level = q.level.toUpperCase();
      if (q.category) where.category = q.category.toLowerCase();
      if (q.search) where.message = { contains: q.search, mode: 'insensitive' };
      if (q.before) where.createdAt = { lt: new Date(q.before) };

      const logs = await prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return reply.send({ logs: logs.reverse() });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      await prisma.systemLog.deleteMany({ where: { organizationId: orgId } });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          level: z.enum(['INFO', 'SUCCESS', 'WARNING', 'ERROR']),
          category: z.string().default('system'),
          message: z.string().min(1),
          meta: z.record(z.unknown()).optional(),
        })
        .parse(request.body);

      const log = await prisma.systemLog.create({
        data: {
          organizationId: orgId,
          level: body.level,
          category: body.category,
          message: body.message,
          meta: (body.meta as object | undefined) ?? undefined,
        },
      });
      return reply.status(201).send({ log });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
