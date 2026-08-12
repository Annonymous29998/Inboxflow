import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { deliveredRecipientFilter } from '../campaigns/recipient-stats.js';
import {
  countHumanClicks,
  countHumanOpens,
  humanClickCountByContact,
  humanOpenCountByContact,
} from '../../services/tracking/recount.js';
import { getCampaignLiveStats } from '../../services/campaigns/live-stats.js';
import { buildDashboardPayload, dashboardFingerprint } from './dashboard-builder.js';

// Very small in-memory TTL cache for dashboard & per-campaign analytics summary payloads.
// Eliminates repeated identical DB calls on fast page refreshes (10-second TTL).
type CacheEntry<T> = { value: T; expires: number };
const cache = new Map<string, CacheEntry<unknown>>();
function getCached<T>(key: string): T | undefined {
  const v = cache.get(key) as CacheEntry<T> | undefined;
  if (!v) return undefined;
  if (Date.now() > v.expires) {
    cache.delete(key);
    return undefined;
  }
  return v.value;
}
function setCached<T>(key: string, value: T, ttlMs = 10_000): void {
  cache.set(key, { value, expires: Date.now() + ttlMs });
  // Prevent unbounded growth (LRU-ish eviction of 20% oldest when cache exceeds 512 entries)
  if (cache.size > 512) {
    const keys = cache.keys();
    const toRemove = Math.ceil(cache.size * 0.2);
    for (let i = 0; i < toRemove; i++) {
      const n = keys.next();
      if (n.done) break;
      cache.delete(n.value);
    }
  }
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/dashboard', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const q = request.query as { live?: string };
      const skipCache = q.live === '1' || q.live === 'true';
      const cacheKey = `dash:${orgId}`;
      if (!skipCache) {
        const cached = getCached<{ stats: unknown; recentCampaigns: unknown }>(cacheKey);
        if (cached) return reply.send(cached);
      }

      const response = await buildDashboardPayload(orgId);
      if (!skipCache) setCached(cacheKey, response, 5_000);
      return reply.send(response);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/dashboard/stream', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const SSE_KEEPALIVE_MS = 15_000;
      const SSE_POLL_MS = 2000;

      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
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

      let stopped = false;
      let lastKey = '';
      const send = (evt: string, data: Record<string, unknown>) => {
        if (stopped) return;
        const chunk =
          (evt ? `event: ${evt}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
        try {
          reply.raw.write(chunk);
        } catch {
          /* client disconnected */
        }
      };

      const initial = await buildDashboardPayload(orgId);
      lastKey = dashboardFingerprint(initial);
      send('dashboard', initial as unknown as Record<string, unknown>);

      const poll = setInterval(async () => {
        if (stopped) return;
        try {
          const fresh = await buildDashboardPayload(orgId);
          const key = dashboardFingerprint(fresh);
          if (key !== lastKey) {
            lastKey = key;
            send('dashboard', fresh as unknown as Record<string, unknown>);
          }
          send('ping', { t: Date.now() });
        } catch {
          /* ignore transient errors */
        }
      }, SSE_POLL_MS);

      const keepalive = setInterval(() => send('ping', { t: Date.now() }), SSE_KEEPALIVE_MS);

      function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(poll);
        clearInterval(keepalive);
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      }

      reply.raw.on('close', stop);
      reply.raw.on('error', stop);

      return reply;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/campaigns/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const cacheKey = `campaign-ana:${id}`;
      const cached = getCached<{
        campaign: typeof campaign;
        eventCounts: Record<string, number>;
        topLinks: Array<{ url: string | null; clicks: number }>;
        devices: Array<{ device: string | null; count: number }>;
        emailClients: Array<{ client: string | null; count: number }>;
        timeline: Array<{ date: string; opened: number; clicked: number; delivered: number }>;
      }>(cacheKey);
      if (cached) return reply.send({ ...cached, campaign });

      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      const [events, clicks, devices, clients, recentEvents] = await Promise.all([
        prisma.trackingEvent.groupBy({
          by: ['type'],
          where: { campaignId: id },
          _count: { _all: true },
        }),
        prisma.trackingEvent.groupBy({
          by: ['url'],
          where: { campaignId: id, type: 'CLICKED', url: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { url: 'desc' } },
          take: 10,
        }),
        prisma.trackingEvent.groupBy({
          by: ['device'],
          where: { campaignId: id, device: { not: null } },
          _count: { _all: true },
        }),
        prisma.trackingEvent.groupBy({
          by: ['emailClient'],
          where: { campaignId: id, emailClient: { not: null } },
          _count: { _all: true },
        }),
        prisma.trackingEvent.findMany({
          where: { campaignId: id, createdAt: { gte: since }, type: { in: ['OPENED', 'CLICKED', 'DELIVERED'] } },
          select: { type: true, createdAt: true },
          // Speed up timeline build: most recent 25k events only (14 days). If there are more than
          // this, a user would already see very-high-level stats and the timeline is still representative.
          take: 25_000,
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      const byDay: Record<string, { opened: number; clicked: number; delivered: number }> = {};
      const todayISO = new Date().toISOString().slice(0, 10);
      for (const e of recentEvents) {
        const day = e.createdAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { opened: 0, clicked: 0, delivered: 0 };
        if (e.type === 'OPENED') byDay[day].opened++;
        if (e.type === 'CLICKED') byDay[day].clicked++;
        if (e.type === 'DELIVERED') byDay[day].delivered++;
      }
      // Always include TODAY even with 0 events, so timeline UX doesn't jump to 14 days ago gap
      if (!byDay[todayISO]) byDay[todayISO] = { opened: 0, clicked: 0, delivered: 0 };

      const response = {
        campaign,
        eventCounts: Object.fromEntries(events.map((e) => [e.type, e._count._all])) as Record<
          string,
          number
        >,
        topLinks: clicks.map((c) => ({ url: c.url, clicks: c._count._all })),
        devices: devices.map((d) => ({ device: d.device, count: d._count._all })),
        emailClients: clients.map((c) => ({ client: c.emailClient, count: c._count._all })),
        timeline: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-14) // hard cap last 14 days
          .map(([date, values]) => ({ date, ...values })),
      };
      setCached(cacheKey, response, 15_000);
      return reply.send(response);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/campaigns/:id/recipients', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const q = request.query as { page?: string; limit?: string; filter?: string; search?: string };
      const page = Math.max(1, parseInt(q.page || '1', 10));
      const limit = Math.min(200, Math.max(10, parseInt(q.limit || '50', 10)));
      const skip = (page - 1) * limit;

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: {
          id: true,
          sentCount: true,
          totalRecipients: true,
          deliveredCount: true,
          openedCount: true,
          clickedCount: true,
          failedCount: true,
        },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const statusFilter =
        q.filter && q.filter !== 'ALL'
          ? q.filter === 'DELIVERED'
            ? { status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'] as never } }
            : { status: q.filter as never }
          : {};
      const searchFilter = q.search
        ? { contact: { email: { contains: q.search, mode: 'insensitive' as const } } }
        : {};

      const where = { campaignId: id, ...statusFilter, ...searchFilter };

      const [recipients, total, failedLive, deliveredLive, humanOpened, humanClicked] = await Promise.all([
        prisma.campaignRecipient.findMany({
          where,
          include: {
            contact: { select: { email: true, firstName: true, lastName: true } },
          },
          orderBy: [{ openedAt: 'desc' }, { clickedAt: 'desc' }, { sentAt: 'desc' }],
          skip,
          take: limit,
        }),
        prisma.campaignRecipient.count({ where }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'FAILED' } }),
        prisma.campaignRecipient.count({ where: deliveredRecipientFilter(id) }),
        countHumanOpens(id),
        countHumanClicks(id),
      ]);

      const contactIds = recipients.map((r) => r.contactId).filter(Boolean);
      const [openMap, clickMap] = await Promise.all([
        humanOpenCountByContact(id, contactIds),
        humanClickCountByContact(id, contactIds),
      ]);

      return reply.send({
        summary: {
          sent: campaign.totalRecipients || campaign.sentCount,
          delivered: deliveredLive || campaign.deliveredCount || campaign.sentCount,
          opened: humanOpened,
          clicked: humanClicked,
          failed: failedLive || campaign.failedCount || 0,
        },
        recipients: recipients.map((r) => ({
          id: r.id,
          email: r.contact.email,
          name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') || null,
          status: r.status,
          delivered: !!r.deliveredAt,
          opened: (openMap[r.contactId] ?? 0) > 0,
          clicked: (clickMap[r.contactId] ?? 0) > 0,
          bounced: !!r.bouncedAt,
          openCount: openMap[r.contactId] ?? 0,
          clickCount: clickMap[r.contactId] ?? 0,
          sentAt: r.sentAt,
          openedAt: r.openedAt,
          clickedAt: r.clickedAt,
          error: r.error,
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/compare', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const q = request.query as { ids?: string };
      const ids = (q.ids || '').split(',').filter(Boolean).slice(0, 5);
      if (!ids.length) throw new AppError(400, 'Provide campaign ids');

      const campaigns = await prisma.campaign.findMany({
        where: { organizationId: orgId, id: { in: ids } },
        select: {
          id: true,
          name: true,
          sentCount: true,
          deliveredCount: true,
          openedCount: true,
          clickedCount: true,
          bouncedCount: true,
          deliverabilityScore: true,
        },
      });

      return reply.send({
        campaigns: campaigns.map((c) => ({
          ...c,
          openRate: c.sentCount ? (c.openedCount / c.sentCount) * 100 : 0,
          clickRate: c.sentCount ? (c.clickedCount / c.sentCount) * 100 : 0,
          bounceRate: c.sentCount ? (c.bouncedCount / c.sentCount) * 100 : 0,
        })),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function requireOrg(orgId: string | null): string {
  if (!orgId) throw new AppError(400, 'No organization');
  return orgId;
}
