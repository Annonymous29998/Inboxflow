import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';

export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/dashboard', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);

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

      return reply.send({
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
      });
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

      const events = await prisma.trackingEvent.groupBy({
        by: ['type'],
        where: { campaignId: id },
        _count: { _all: true },
      });

      const clicks = await prisma.trackingEvent.groupBy({
        by: ['url'],
        where: { campaignId: id, type: 'CLICKED', url: { not: null } },
        _count: { _all: true },
        orderBy: {
          _count: {
            url: 'desc',
          },
        },
        take: 10,
      });

      const devices = await prisma.trackingEvent.groupBy({
        by: ['device'],
        where: { campaignId: id, device: { not: null } },
        _count: { _all: true },
      });

      const clients = await prisma.trackingEvent.groupBy({
        by: ['emailClient'],
        where: { campaignId: id, emailClient: { not: null } },
        _count: { _all: true },
      });

      // Time series opens/clicks last 14 days
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const recentEvents = await prisma.trackingEvent.findMany({
        where: { campaignId: id, createdAt: { gte: since }, type: { in: ['OPENED', 'CLICKED', 'DELIVERED'] } },
        select: { type: true, createdAt: true },
      });

      const byDay: Record<string, { opened: number; clicked: number; delivered: number }> = {};
      for (const e of recentEvents) {
        const day = e.createdAt.toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { opened: 0, clicked: 0, delivered: 0 };
        if (e.type === 'OPENED') byDay[day].opened++;
        if (e.type === 'CLICKED') byDay[day].clicked++;
        if (e.type === 'DELIVERED') byDay[day].delivered++;
      }

      return reply.send({
        campaign,
        eventCounts: Object.fromEntries(events.map((e) => [e.type, e._count._all])),
        topLinks: clicks.map((c) => ({ url: c.url, clicks: c._count._all })),
        devices: devices.map((d) => ({ device: d.device, count: d._count._all })),
        emailClients: clients.map((c) => ({ client: c.emailClient, count: c._count._all })),
        timeline: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, values]) => ({ date, ...values })),
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
