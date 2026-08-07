import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';

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
      const cacheKey = `dash:${orgId}`;
      const cached = getCached<{ stats: unknown; recentCampaigns: unknown }>(cacheKey);
      if (cached) return reply.send(cached);

      const [
        totalContacts,
        activeCampaigns,
        scheduledCampaigns,
        campaigns,
        domains,
        recentCampaigns,
      ] = await Promise.all([
        prisma.contact.count({ where: { organizationId: orgId, status: 'SUBSCRIBED' } }),
        prisma.campaign.count({ where: { organizationId: orgId, status: { in: ['SENDING', 'READY'] } } }),
        prisma.campaign.count({ where: { organizationId: orgId, status: 'SCHEDULED' } }),
        prisma.campaign.findMany({
          where: { organizationId: orgId, status: { in: ['SENT', 'SENDING'] } },
          select: {
            sentCount: true,
            deliveredCount: true,
            openedCount: true,
            clickedCount: true,
            bouncedCount: true,
            complainedCount: true,
          },
        }),
        prisma.domain.findMany({ where: { organizationId: orgId } }),
        prisma.campaign.findMany({
          where: { organizationId: orgId },
          orderBy: { updatedAt: 'desc' },
          take: 8,
          select: {
            id: true,
            name: true,
            status: true,
            subject: true,
            sentCount: true,
            openedCount: true,
            clickedCount: true,
            bouncedCount: true,
            deliverabilityScore: true,
            sentAt: true,
            updatedAt: true,
          },
        }),
      ]);

      const totals = campaigns.reduce(
        (acc, c) => {
          acc.sent += c.sentCount;
          acc.delivered += c.deliveredCount || c.sentCount;
          acc.opened += c.openedCount;
          acc.clicked += c.clickedCount;
          acc.bounced += c.bouncedCount;
          acc.complained += c.complainedCount;
          return acc;
        },
        { sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 },
      );

      const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);

      const verifiedDomains = domains.filter((d) => d.status === 'VERIFIED');
      const avgReputation =
        domains.length > 0
          ? Math.round(domains.reduce((s, d) => s + d.reputationScore, 0) / domains.length)
          : 0;

      const response = {
        stats: {
          totalContacts,
          activeCampaigns,
          scheduledCampaigns,
          emailsSent: totals.sent,
          deliveryRate: rate(totals.delivered, totals.sent),
          bounceRate: rate(totals.bounced, totals.sent),
          openRate: rate(totals.opened, totals.delivered || totals.sent),
          clickRate: rate(totals.clicked, totals.opened || totals.delivered || totals.sent),
          spamComplaintRate: rate(totals.complained, totals.sent),
          domainHealth: verifiedDomains.length
            ? verifiedDomains.every((d) => d.spfValid && d.dkimValid && d.dmarcValid)
              ? 'healthy'
              : 'needs_attention'
            : 'not_configured',
          senderReputationScore: avgReputation,
          domainsConfigured: domains.length,
          domainsVerified: verifiedDomains.length,
        },
        recentCampaigns,
      };
      setCached(cacheKey, response, 10_000);
      return reply.send(response);
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
        select: { id: true, sentCount: true, deliveredCount: true, openedCount: true, clickedCount: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const statusFilter = q.filter && q.filter !== 'ALL' ? { status: q.filter as never } : {};
      const searchFilter = q.search
        ? { contact: { email: { contains: q.search, mode: 'insensitive' as const } } }
        : {};

      const where = { campaignId: id, ...statusFilter, ...searchFilter };

      const [recipients, total] = await Promise.all([
        prisma.campaignRecipient.findMany({
          where,
          include: {
            contact: { select: { email: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'asc' },
          skip,
          take: limit,
        }),
        prisma.campaignRecipient.count({ where }),
      ]);

      // Get per-contact open/click counts from tracking events
      const contactIds = recipients.map((r) => r.contactId).filter(Boolean);
      const [openCounts, clickCounts] = await Promise.all([
        prisma.trackingEvent.groupBy({
          by: ['contactId'],
          where: { campaignId: id, type: 'OPENED', contactId: { in: contactIds } },
          _count: { _all: true },
        }),
        prisma.trackingEvent.groupBy({
          by: ['contactId'],
          where: { campaignId: id, type: 'CLICKED', contactId: { in: contactIds } },
          _count: { _all: true },
        }),
      ]);

      const openMap = Object.fromEntries(openCounts.map((e) => [e.contactId, e._count._all]));
      const clickMap = Object.fromEntries(clickCounts.map((e) => [e.contactId, e._count._all]));

      return reply.send({
        summary: {
          sent: campaign.sentCount,
          delivered: campaign.deliveredCount || campaign.sentCount,
          opened: campaign.openedCount,
          clicked: campaign.clickedCount,
        },
        recipients: recipients.map((r) => ({
          id: r.id,
          email: r.contact.email,
          name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') || null,
          status: r.status,
          delivered: !!r.deliveredAt,
          opened: !!r.openedAt,
          clicked: !!r.clickedAt,
          bounced: !!r.bouncedAt,
          openCount: openMap[r.contactId] ?? (r.openedAt ? 1 : 0),
          clickCount: clickMap[r.contactId] ?? (r.clickedAt ? 1 : 0),
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
