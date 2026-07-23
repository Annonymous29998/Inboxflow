import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { parseContactImport } from './import-parser.js';

export async function contactRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const q = request.query as {
        page?: string;
        limit?: string;
        search?: string;
        status?: string;
        tag?: string;
        listId?: string;
      };
      const page = Number(q.page || 1);
      const limit = Math.min(Number(q.limit || 50), 200);
      const where: Prisma.ContactWhereInput = { organizationId: orgId };
      if (q.status) {
        where.status = q.status as 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED' | 'CLEANED';
      }
      if (q.search) {
        where.OR = [
          { email: { contains: q.search, mode: 'insensitive' } },
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName: { contains: q.search, mode: 'insensitive' } },
        ];
      }
      if (q.tag) {
        where.tagAssignments = { some: { tag: { name: q.tag } } };
      }
      if (q.listId) {
        where.listMemberships = { some: { listId: q.listId } };
      }

      const [contacts, total] = await Promise.all([
        prisma.contact.findMany({
          where,
          include: {
            tagAssignments: { include: { tag: true } },
            listMemberships: { include: { list: { select: { id: true, name: true } } } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.contact.count({ where }),
      ]);

      return reply.send({ contacts, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          email: z.string().email(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
          customData: z.record(z.string(), z.unknown()).optional(),
          tags: z.array(z.string()).optional(),
          listIds: z.array(z.string()).optional(),
          consent: z.boolean().optional(),
        })
        .parse(request.body);

      const existing = await prisma.contact.findUnique({
        where: { organizationId_email: { organizationId: orgId, email: body.email.toLowerCase() } },
      });
      if (existing) throw new AppError(409, 'Contact already exists', 'DUPLICATE');

      const suppressed = await prisma.suppressionList.findUnique({
        where: {
          organizationId_email: { organizationId: orgId, email: body.email.toLowerCase() },
        },
      });
      if (suppressed) throw new AppError(400, 'Email is on suppression list');

      const contact = await prisma.contact.create({
        data: {
          organizationId: orgId,
          email: body.email.toLowerCase(),
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          customData: (body.customData || {}) as Prisma.InputJsonValue,
          consentAt: body.consent ? new Date() : undefined,
          consentIp: body.consent ? request.ip : undefined,
          ...(body.listIds?.length
            ? {
                listMemberships: {
                  create: body.listIds.map((listId) => ({ listId })),
                },
              }
            : {}),
        },
      });

      if (body.tags?.length) {
        for (const name of body.tags) {
          const tag = await prisma.tag.upsert({
            where: { organizationId_name: { organizationId: orgId, name } },
            create: { organizationId: orgId, name },
            update: {},
          });
          await prisma.contactTag.create({
            data: { contactId: contact.id, tagId: tag.id },
          });
        }
      }

      return reply.status(201).send({ contact });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const contact = await prisma.contact.findFirst({
        where: { id, organizationId: orgId },
        include: {
          tagAssignments: { include: { tag: true } },
          listMemberships: { include: { list: true } },
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
        },
      });
      if (!contact) throw new AppError(404, 'Contact not found');
      return reply.send({ contact });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
          status: z.enum(['SUBSCRIBED', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'CLEANED']).optional(),
          customData: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(request.body);

      const existing = await prisma.contact.findFirst({ where: { id, organizationId: orgId } });
      if (!existing) throw new AppError(404, 'Contact not found');

      const contact = await prisma.contact.update({
        where: { id },
        data: {
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          status: body.status,
          customData: body.customData as Prisma.InputJsonValue | undefined,
          ...(body.status === 'UNSUBSCRIBED' ? { unsubscribedAt: new Date() } : {}),
        },
      });
      return reply.send({ contact });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.contact.deleteMany({ where: { id, organizationId: orgId } });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/import', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          /** Raw file or pasted document content */
          content: z.string().optional(),
          /** @deprecated use content */
          csv: z.string().optional(),
          listId: z.string().optional(),
          /** Create a new list and add imported contacts to it */
          listName: z.string().optional(),
          updateExisting: z.boolean().default(true),
        })
        .parse(request.body);

      const raw = (body.content || body.csv || '').trim();
      if (!raw) throw new AppError(400, 'No import content provided');

      let listId = body.listId;
      if (!listId && body.listName?.trim()) {
        const list = await prisma.contactList.create({
          data: {
            organizationId: orgId,
            name: body.listName.trim(),
            description: 'Created from contact import',
          },
        });
        listId = list.id;
      }

      const rows = parseContactImport(raw);
      if (!rows.length) {
        throw new AppError(400, 'No valid email addresses found in the file or text');
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      let addedToList = 0;
      const duplicates: string[] = [];

      async function ensureListMembership(contactId: string) {
        if (!listId) return;
        await prisma.contactListMember.upsert({
          where: { listId_contactId: { listId, contactId } },
          create: { listId, contactId },
          update: {},
        });
        addedToList++;
      }

      for (const row of rows) {
        const email = row.email;
        const data = {
          firstName: row.firstName || null,
          lastName: row.lastName || null,
          phone: row.phone || null,
        };

        const existing = await prisma.contact.findUnique({
          where: { organizationId_email: { organizationId: orgId, email } },
        });

        if (existing) {
          duplicates.push(email);
          if (body.updateExisting) {
            await prisma.contact.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            skipped++;
          }
          await ensureListMembership(existing.id);
        } else {
          const suppressed = await prisma.suppressionList.findUnique({
            where: { organizationId_email: { organizationId: orgId, email } },
          });
          if (suppressed) {
            skipped++;
            continue;
          }

          const contact = await prisma.contact.create({
            data: {
              organizationId: orgId,
              email,
              ...data,
              source: 'import',
              consentAt: new Date(),
            },
          });
          await ensureListMembership(contact.id);
          created++;
        }
      }

      return reply.send({
        created,
        updated,
        skipped,
        addedToList,
        listId: listId || null,
        duplicates: duplicates.slice(0, 100),
        total: rows.length,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/export/csv', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const contacts = await prisma.contact.findMany({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
      });
      const csv = stringify(
        contacts.map((c) => ({
          email: c.email,
          firstName: c.firstName || '',
          lastName: c.lastName || '',
          phone: c.phone || '',
          status: c.status,
          createdAt: c.createdAt.toISOString(),
        })),
        { header: true },
      );
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="contacts.csv"');
      return reply.send(csv);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/tags', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z.object({ tags: z.array(z.string()) }).parse(request.body);
      const contact = await prisma.contact.findFirst({ where: { id, organizationId: orgId } });
      if (!contact) throw new AppError(404, 'Contact not found');

      for (const name of body.tags) {
        const tag = await prisma.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name } },
          create: { organizationId: orgId, name },
          update: {},
        });
        await prisma.contactTag.upsert({
          where: { contactId_tagId: { contactId: id, tagId: tag.id } },
          create: { contactId: id, tagId: tag.id },
          update: {},
        });
      }
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function requireOrg(orgId: string | null): string {
  if (!orgId) throw new AppError(400, 'No organization');
  return orgId;
}
