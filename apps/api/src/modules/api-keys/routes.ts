import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';
import { generateApiKey } from '../../utils/crypto.js';

export async function apiKeyRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const keys = await prisma.apiKey.findMany({
        where: { organizationId: orgId, revokedAt: null },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          lastUsedAt: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      return reply.send({ keys });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          name: z.string(),
          scopes: z.array(z.string()).default(['read', 'write']),
          expiresAt: z.string().datetime().optional(),
        })
        .parse(request.body);

      const { key, prefix, hash } = generateApiKey();
      const record = await prisma.apiKey.create({
        data: {
          organizationId: orgId,
          userId: request.user.id,
          name: body.name,
          keyHash: hash,
          keyPrefix: prefix,
          scopes: body.scopes,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        },
      });

      return reply.status(201).send({
        key: { ...record, secret: key },
        notice: 'Store this key securely. It will not be shown again.',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.apiKey.updateMany({
        where: { id, organizationId: orgId },
        data: { revokedAt: new Date() },
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
