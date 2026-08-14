import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { deliveredRecipientFilter, inboxDeliveredFilter } from '../campaigns/recipient-stats.js';
import {
  countHumanClicks,
  countHumanOpens,
  humanClickCountByContact,
  humanOpenCountByContact,
} from '../../services/tracking/recount.js';
import { getCampaignLiveStats } from '../../services/campaigns/live-stats.js';
import { isCountableClick, isCountableOpen } from '../../utils/tracking-bot-filter.js';
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
      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: {
          id: true,
          name: true,
          status: true,
          subject: true,
          sentAt: true,
          totalRecipients: true,
          sentCount: true,
          openedCount: true,
          clickedCount: true,
          bouncedCount: true,
          deliveredCount: true,
          failedCount: true,
          deliverabilityScore: true,
        },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const live = await getCampaignLiveStats(id, campaign.totalRecipients);
      const campaignOut = {
        ...campaign,
        sentCount: Math.max(live.sentCount, campaign.totalRecipients, campaign.sentCount),
        openedCount: live.openedCount,
        clickedCount: live.clickedCount,
        bouncedCount: live.bouncedCount || campaign.bouncedCount,
        deliveredCount: live.deliveredCount,
        failedCount: live.failedCount,
      };

      const cacheKey = `campaign-ana:${id}`;
      const cached = getCached<{
        eventCounts: Record<string, number>;
        topLinks: Array<{ url: string | null; clicks: number }>;
        devices: Array<{ device: string | null; count: number }>;
        emailClients: Array<{ client: string | null; count: number }>;
        timeline: Array<{ date: string; opened: number; clicked: number; delivered: number }>;
      }>(cacheKey);
      if (cached) return reply.send({ ...cached, campaign: campaignOut });

      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

      const [trackEvents, sentRows] = await Promise.all([
        prisma.trackingEvent.findMany({
          where: {
            campaignId: id,
            createdAt: { gte: since },
            type: { in: ['OPENED', 'CLICKED', 'SENT', 'DELIVERED'] },
          },
          select: {
            type: true,
            createdAt: true,
            url: true,
            device: true,
            emailClient: true,
            userAgent: true,
            metadata: true,
          },
          take: 25_000,
          orderBy: { createdAt: 'asc' },
        }),
        prisma.campaignRecipient.findMany({
          where: { campaignId: id, sentAt: { not: null } },
          select: { sentAt: true },
        }),
      ]);

      const countable = trackEvents.filter((e) => {
        if (e.type === 'OPENED') return isCountableOpen(e.userAgent, e.metadata);
        if (e.type === 'CLICKED') return isCountableClick(e.userAgent, e.metadata);
        return e.type === 'SENT' || e.type === 'DELIVERED';
      });

      const byDay: Record<string, { opened: number; clicked: number; delivered: number }> = {};
      const todayISO = new Date().toISOString().slice(0, 10);
      for (const e of countable) {
        const day = e.createdAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { opened: 0, clicked: 0, delivered: 0 };
        if (e.type === 'OPENED') byDay[day].opened += 1;
        if (e.type === 'CLICKED') byDay[day].clicked += 1;
      }
      for (const r of sentRows) {
        if (!r.sentAt) continue;
        const day = r.sentAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { opened: 0, clicked: 0, delivered: 0 };
        byDay[day].delivered += 1;
      }
      if (!byDay[todayISO]) byDay[todayISO] = { opened: 0, clicked: 0, delivered: 0 };

      const linkCounts = new Map<string, number>();
      const deviceCounts = new Map<string, number>();
      const clientCounts = new Map<string, number>();
      const typeCounts: Record<string, number> = {};
      for (const e of countable) {
        typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
        if (e.type === 'CLICKED' && e.url) {
          linkCounts.set(e.url, (linkCounts.get(e.url) ?? 0) + 1);
        }
        if (e.device) deviceCounts.set(e.device, (deviceCounts.get(e.device) ?? 0) + 1);
        if (e.emailClient) clientCounts.set(e.emailClient, (clientCounts.get(e.emailClient) ?? 0) + 1);
      }

      const charts = {
        eventCounts: typeCounts,
        topLinks: [...linkCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([url, clicks]) => ({ url, clicks })),
        devices: [...deviceCounts.entries()].map(([device, count]) => ({ device, count })),
        emailClients: [...clientCounts.entries()].map(([client, count]) => ({ client, count })),
        timeline: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-14)
          .map(([date, values]) => ({ date, ...values })),
      };
      setCached(cacheKey, charts, 15_000);
      return reply.send({ campaign: campaignOut, ...charts });
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
          bouncedCount: true,
        },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const statusFilter =
        q.filter && q.filter !== 'ALL'
          ? q.filter === 'DELIVERED'
            ? inboxDeliveredFilter(id)
            : q.filter === 'SENT'
              ? { status: 'SENT' as never }
              : { status: q.filter as never }
          : {};
      const searchFilter = q.search
        ? { contact: { email: { contains: q.search, mode: 'insensitive' as const } } }
        : {};

      const where =
        q.filter === 'DELIVERED'
          ? { ...statusFilter, ...searchFilter }
          : { campaignId: id, ...statusFilter, ...searchFilter };

      const [recipients, total, failedLive, bouncedLive, smtpAccepted, inboxDelivered, humanOpened, humanClicked] =
        await Promise.all([
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
          prisma.campaignRecipient.count({ where: { campaignId: id, status: 'BOUNCED' } }),
          prisma.campaignRecipient.count({ where: deliveredRecipientFilter(id) }),
          prisma.campaignRecipient.count({ where: inboxDeliveredFilter(id) }),
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
          /** Audience size for this campaign */
          sent: campaign.totalRecipients || smtpAccepted || campaign.sentCount,
          /** SMTP accepted (left our servers) */
          accepted: smtpAccepted,
          /** ESP-confirmed delivery or engagement — not mere SMTP accept */
          delivered: inboxDelivered,
          opened: humanOpened,
          clicked: humanClicked,
          failed: failedLive || campaign.failedCount || 0,
          bounced: bouncedLive || campaign.bouncedCount || 0,
        },
        recipients: recipients.map((r) => {
          const pixelOpens = openMap[r.contactId] ?? 0;
          const clicks = clickMap[r.contactId] ?? 0;
          const clicked = clicks > 0 || !!r.clickedAt || r.status === 'CLICKED';
          const opened = pixelOpens > 0 || !!r.openedAt || clicked;
          return {
          id: r.id,
          email: r.contact.email,
          name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') || null,
          status: r.status,
          delivered:
            !!r.deliveredAt ||
            r.status === 'DELIVERED' ||
            r.status === 'OPENED' ||
            r.status === 'CLICKED',
          opened,
          clicked,
          bounced: !!r.bouncedAt || r.status === 'BOUNCED',
          openCount: pixelOpens > 0 ? pixelOpens : opened ? 1 : 0,
          clickCount: clicks > 0 ? clicks : clicked ? 1 : 0,
          sentAt: r.sentAt,
          openedAt: r.openedAt,
          clickedAt: r.clickedAt,
          error: r.error,
          };
        }),
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
