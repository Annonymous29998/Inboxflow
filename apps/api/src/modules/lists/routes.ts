import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';

export async function listRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const lists = await prisma.contactList.findMany({
        where: { organizationId: orgId },
        include: { _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      });
      return reply.send({ lists });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z.object({ name: z.string(), description: z.string().optional() }).parse(request.body);
      const list = await prisma.contactList.create({
        data: { organizationId: orgId, name: body.name, description: body.description },
      });
      return reply.status(201).send({ list });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.contactList.deleteMany({ where: { id, organizationId: orgId } });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

export async function segmentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const segments = await prisma.segment.findMany({ where: { organizationId: orgId } });
      return reply.send({ segments });
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
          description: z.string().optional(),
          rules: z.object({
            match: z.enum(['all', 'any']).default('all'),
            conditions: z.array(
              z.object({
                field: z.string(),
                operator: z.string(),
                value: z.string(),
              }),
            ),
          }),
        })
        .parse(request.body);

      const segment = await prisma.segment.create({
        data: {
          organizationId: orgId,
          name: body.name,
          description: body.description,
          rules: body.rules,
        },
      });
      return reply.status(201).send({ segment });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

export async function templateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const templates = await prisma.template.findMany({
        where: { OR: [{ organizationId: orgId }, { isPublic: true }] },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          isPublic: true,
          organizationId: true,
          thumbnailUrl: true,
          updatedAt: true,
          createdAt: true,
        },
      });
      return reply.send({ templates });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const template = await prisma.template.findFirst({
        where: { id, OR: [{ organizationId: orgId }, { isPublic: true }] },
      });
      if (!template) throw new AppError(404, 'Template not found');
      return reply.send({ template });
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
          description: z.string().optional(),
          htmlContent: z.string().optional(),
          plainText: z.string().optional(),
          editorJson: z.unknown().optional(),
          mjmlSource: z.string().optional(),
        })
        .parse(request.body);

      const template = await prisma.template.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: body.name,
          description: body.description,
          htmlContent: body.htmlContent,
          plainText: body.plainText,
          editorJson: body.editorJson as object | undefined,
          mjmlSource: body.mjmlSource,
        },
      });
      return reply.status(201).send({ template });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/duplicate', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const source = await prisma.template.findFirst({
        where: { id, OR: [{ organizationId: orgId }, { isPublic: true }] },
      });
      if (!source) throw new AppError(404, 'Template not found');
      const template = await prisma.template.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: `${source.name} (Copy)`,
          description: source.description,
          htmlContent: source.htmlContent,
          plainText: source.plainText,
          editorJson: source.editorJson ?? undefined,
          mjmlSource: source.mjmlSource,
        },
      });
      return reply.status(201).send({ template });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const template = await prisma.template.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!template) throw new AppError(404, 'Template not found');

      await prisma.$transaction([
        prisma.campaign.updateMany({ where: { templateId: id }, data: { templateId: null } }),
        prisma.template.delete({ where: { id } }),
      ]);

      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
