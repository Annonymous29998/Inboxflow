import type { FastifyInstance } from 'fastify';
import z from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import {
  emitJobUpdate,
  getJobOrThrow,
  subscribeJob,
  toUpdate,
  upsertJobProgress,
  type JobUpdate,
  type UpsertJobInput,
} from './progress.js';

const SSE_KEEPALIVE_MS = 15_000;
const SSE_POLL_MS = 500;

export async function jobRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    // Fallback: query param ?token=X (works with EventSource & vercel streaming)
    const q = (request.query as any)?.token as string | undefined;
    if (q && !(request.headers as any).authorization) {
      (request.headers as any).authorization = `Bearer ${q}`;
    }
    try {
      await (request as any).jwtVerify();
    } catch (err: any) {
      throw new AppError(401, err.message || 'Unauthorized');
    }
  });

  app.get('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const job = await getJobOrThrow(orgId, id);
      return reply.send(toUpdate(job));
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
          type: z.enum(['CONTACT_IMPORT', 'CAMPAIGN_SEND', 'LIST_CLEAR', 'CONTACT_EXPORT', 'TEMPLATE_RENDER', 'DELIVERABILITY_ANALYZE']).optional(),
          status: z.enum(['PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED']).optional(),
          total: z.number().int().nonnegative().optional(),
          processed: z.number().int().nonnegative().optional(),
          campaignId: z.string().optional().nullable(),
          resourceId: z.string().optional().nullable(),
          meta: z.record(z.any()).or(z.array(z.any())).optional().nullable(),
          error: z.string().optional().nullable(),
          startedAt: z.string().datetime().optional().nullable(),
          finishedAt: z.string().datetime().optional().nullable(),
        })
        .parse(request.body as any);

      const existing = await prisma.job.findFirst({ where: { id, organizationId: orgId } });
      if (!existing) throw new AppError(404, 'Job not found');

      const input: UpsertJobInput = {
        id,
        type: (body.type as any) ?? existing.type,
        organizationId: orgId,
        status: (body.status as any) ?? existing.status,
        total: body.total ?? undefined,
        processed: body.processed ?? undefined,
        campaignId: body.campaignId ?? undefined,
        resourceId: body.resourceId ?? undefined,
        meta: body.meta ?? undefined,
        error: body.error ?? undefined,
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
        finishedAt: body.finishedAt ? new Date(body.finishedAt) : undefined,
      };
      const job = await upsertJobProgress(input);
      return reply.send(toUpdate(job));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/stream', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };

      const initial = await getJobOrThrow(orgId, id);

      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      // reply.raw bypasses @fastify/cors — set CORS manually so browser progress streams work.
      const origin = String(request.headers.origin || '');
      const allowed = (await import('../../config/env.js')).env.CORS_ORIGIN.split(',').map((s) =>
        s.trim(),
      );
      if (origin && allowed.includes(origin)) {
        reply.raw.setHeader('Access-Control-Allow-Origin', origin);
        reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
        reply.raw.setHeader('Vary', 'Origin');
      }
      if (reply.raw.socket) {
        reply.raw.socket.setNoDelay(true);
        reply.raw.socket.setKeepAlive(true, SSE_KEEPALIVE_MS);
      }
      reply.raw.flushHeaders?.();

      let lastSentUpdated = initial.updatedAt?.getTime() ?? 0;
      let stopped = false;
      const send = (evt: string, data: Record<string, any>) => {
        if (stopped) return;
        const chunk =
          (evt ? `event: ${evt}\n` : '') +
          `data: ${JSON.stringify(data)}\n\n`;
        try {
          reply.raw.write(chunk);
        } catch {}
      };

      send('job', toUpdate(initial));
      emitJobUpdate(initial);

      const unsub = subscribeJob(id, (u: JobUpdate) => {
        lastSentUpdated = Date.now();
        send('job', u);
      });

      const poll = setInterval(async () => {
        if (stopped) return;
        try {
          const fresh = await prisma.job.findFirst({ where: { id, organizationId: orgId } });
          if (!fresh) {
            send('error', { message: 'Job deleted' });
            stop();
            return;
          }
          if ((fresh.updatedAt?.getTime() ?? 0) > lastSentUpdated) {
            lastSentUpdated = fresh.updatedAt?.getTime() ?? 0;
            const u = toUpdate(fresh);
            emitJobUpdate(fresh);
            send('job', u);
          }
          send('ping', { t: Date.now() });
        } catch {}
      }, SSE_POLL_MS);

      const keepalive = setInterval(() => send('ping', { t: Date.now() }), SSE_KEEPALIVE_MS);

      function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(poll);
        clearInterval(keepalive);
        unsub();
        try { reply.raw.end(); } catch {}
      }

      reply.raw.on('close', stop);
      reply.raw.on('error', stop);

      const status = initial.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
        setTimeout(() => stop(), 1500);
      }

      return reply;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
