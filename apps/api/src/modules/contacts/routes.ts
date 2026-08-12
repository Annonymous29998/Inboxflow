import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { stringify } from 'csv-stringify/sync';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { parseContactImport } from './import-parser.js';
import { upsertJobProgress } from '../jobs/progress.js';
import { audienceContactWhere, removeContactsFromAudience } from './audience-cleanup.js';

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
      const where: Prisma.ContactWhereInput = audienceContactWhere(orgId, {}, { includeCleaned: q.status === 'CLEANED' });
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
      const existing = await prisma.contact.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
      if (!existing) throw new AppError(404, 'Contact not found');
      const result = await removeContactsFromAudience(orgId, [id]);
      return reply.send({ success: true, ...result });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/import', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          content: z.string().optional(),
          csv: z.string().optional(),
          listId: z.string().optional(),
          listName: z.string().optional(),
          updateExisting: z.boolean().default(true),
          /** Client-prefixed job UUID so multi-chunk imports share one progress stream */
          jobId: z.string().optional(),
          /** 0-based chunk index for this HTTP call (client splits into micro-batches) */
          chunkIndex: z.number().int().nonnegative().default(0),
          /** Total rows across *all* chunks (so percent is correct across chunks) */
          totalRows: z.number().int().nonnegative().optional(),
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

      const total = Math.max(0, body.totalRows ?? rows.length);
      const jobId = body.jobId?.trim() || undefined;
      let jobProcessedBase = 0;
      if (jobId) {
        try {
          const existing = await prisma.job.findUnique({ where: { id: jobId }, select: { processed: true, total: true, id: true } });
          if (existing) jobProcessedBase = Number(existing.processed) || 0;
        } catch {}
        await upsertJobProgress({
          id: jobId,
          type: 'CONTACT_IMPORT',
          organizationId: orgId,
          createdById: request.user.id ?? null,
          resourceId: listId ?? null,
          status: 'RUNNING',
          total,
          processed: Math.min(total, jobProcessedBase),
          startedAt: new Date(),
          meta: { stage: 'importing_rows', listId: listId ?? null, listName: body.listName ?? null, chunkIndex: body.chunkIndex, chunkSize: rows.length },
        });
      }

      async function ensureListMembership(contactId: string) {
        if (!listId) return;
        await prisma.contactListMember.upsert({
          where: { listId_contactId: { listId, contactId } },
          create: { listId, contactId },
          update: {},
        });
        addedToList++;
      }

      async function emitProgress(force = false) {
        if (!jobId) return;
        const processed = Math.min(total, jobProcessedBase + created + updated + skipped);
        const now = Date.now();
        if (!force && (processed - (emitProgress as any).lastSent) < 10) return;
        (emitProgress as any).lastSent = processed;
        try {
          await upsertJobProgress({
            id: jobId,
            type: 'CONTACT_IMPORT',
            organizationId: orgId,
            createdById: request.user.id ?? null,
            resourceId: listId ?? null,
            status: 'RUNNING',
            total,
            processed,
            meta: {
              stage: 'importing_rows',
              listId: listId ?? null,
              listName: body.listName ?? null,
              chunkIndex: body.chunkIndex,
              chunkSize: rows.length,
              created,
              updated,
              skipped,
              addedToList,
            },
          });
        } catch {}
      }
      (emitProgress as any).lastSent = -99999;
      await emitProgress(true);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
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
            await emitProgress();
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
        if (i % 10 === 9) await emitProgress();
      }
      await emitProgress(true);

      if (jobId) {
        const processed = Math.min(total, jobProcessedBase + created + updated + skipped);
        const isLastChunk = processed >= total || !body.totalRows;
        await upsertJobProgress({
          id: jobId,
          type: 'CONTACT_IMPORT',
          organizationId: orgId,
          createdById: request.user.id ?? null,
          resourceId: listId ?? null,
          status: isLastChunk ? 'COMPLETED' : 'RUNNING',
          total,
          processed,
          finishedAt: isLastChunk ? new Date() : null,
          meta: {
            stage: isLastChunk ? 'completed' : 'awaiting_next_chunk',
            listId: listId ?? null,
            listName: body.listName ?? null,
            created,
            updated,
            skipped,
            addedToList,
            chunkIndex: body.chunkIndex,
            chunkSize: rows.length,
          },
        });
      }

      return reply.send({
        created,
        updated,
        skipped,
        addedToList,
        listId: listId || null,
        duplicates: duplicates.slice(0, 100),
        total: rows.length,
        jobId: jobId ?? null,
      });
    } catch (error: any) {
      // Mark job failed if client sent jobId
      try {
        const body = request.body as any;
        const orgId = request.user?.organizationId;
        const jobId = body?.jobId?.trim();
        if (jobId && orgId) {
          await upsertJobProgress({
            id: jobId,
            type: 'CONTACT_IMPORT',
            organizationId: String(orgId),
            createdById: request.user?.id ?? null,
            status: 'FAILED',
            error: String(error?.message || error || 'Import failed').slice(0, 500),
            finishedAt: new Date(),
          });
        }
      } catch {}
      return sendError(reply, error);
    }
  });

  app.delete('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const query = request.query as { listId?: string; status?: string; confirm?: string };
      if (query.confirm !== 'yes') {
        throw new AppError(400, 'Missing confirm=yes parameter');
      }
      const where: Prisma.ContactWhereInput = { organizationId: orgId };
      if (query.listId) {
        where.listMemberships = { some: { listId: query.listId } };
      }
      if (query.status) {
        where.status = query.status as 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED' | 'CLEANED';
      } else {
        // Clear All should not leave CLEANED ghosts counted as remaining audience
        where.status = { not: 'CLEANED' };
      }
      const count = await prisma.contact.count({ where });
      if (!count) {
        return reply.send({ deleted: 0, archived: 0 });
      }
      // Delete in chunks of 500 to avoid huge transactions / locks
      const CHUNK = 500;
      let deleted = 0;
      let archived = 0;
      while (deleted + archived < count) {
        const ids = await prisma.contact.findMany({ where, select: { id: true }, take: CHUNK });
        if (!ids.length) break;
        const result = await removeContactsFromAudience(
          orgId,
          ids.map((c) => c.id),
        );
        deleted += result.deleted;
        archived += result.archived;
        // Avoid tight loop starving other queries
        await new Promise((r) => setTimeout(r, 10));
      }
      return reply.send({ deleted: deleted + archived, hardDeleted: deleted, archived });
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
