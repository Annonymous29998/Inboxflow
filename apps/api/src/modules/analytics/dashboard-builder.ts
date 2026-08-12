import { prisma } from '../../config/prisma.js';
import { getCampaignLiveStats, getOrgLiveEngagement } from '../../services/campaigns/live-stats.js';

export type DashboardPayload = {
  stats: {
    totalContacts: number;
    subscribedContacts: number;
    unsubscribedContacts: number;
    activeCampaigns: number;
    scheduledCampaigns: number;
    emailsSent: number;
    deliveryRate: number;
    bounceRate: number;
    openRate: number;
    clickRate: number;
    spamComplaintRate: number;
    domainHealth: string;
    senderReputationScore: number;
    domainsConfigured: number;
    domainsVerified: number;
  };
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    subject: string | null;
    totalRecipients: number;
    sentCount: number;
    deliveredCount: number;
    failedCount: number;
    pendingCount: number;
    openedCount: number;
    clickedCount: number;
    bouncedCount: number;
    deliverabilityScore: number | null;
    sentAt: Date | null;
    updatedAt: Date;
  }>;
};

const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : 0);

/** Live dashboard payload from queue rows + verified tracking (never cached demo data). */
export async function buildDashboardPayload(organizationId: string): Promise<DashboardPayload> {
  const [
    totalContacts,
    subscribedContacts,
    unsubscribedContacts,
    activeCampaigns,
    scheduledCampaigns,
    domains,
    recentCampaignsRaw,
    liveTotals,
  ] = await Promise.all([
    prisma.contact.count({ where: { organizationId, status: { not: 'CLEANED' } } }),
    prisma.contact.count({ where: { organizationId, status: 'SUBSCRIBED' } }),
    prisma.contact.count({ where: { organizationId, status: 'UNSUBSCRIBED' } }),
    prisma.campaign.count({ where: { organizationId, status: { in: ['SENDING', 'READY'] } } }),
    prisma.campaign.count({ where: { organizationId, status: 'SCHEDULED' } }),
    prisma.domain.findMany({ where: { organizationId } }),
    prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        name: true,
        status: true,
        subject: true,
        totalRecipients: true,
        bouncedCount: true,
        deliverabilityScore: true,
        sentAt: true,
        updatedAt: true,
      },
    }),
    getOrgLiveEngagement(organizationId),
  ]);

  const recentCampaigns = await Promise.all(
    recentCampaignsRaw.map(async (c) => {
      const live = await getCampaignLiveStats(c.id, c.totalRecipients);
      return {
        ...c,
        sentCount: live.sentCount,
        deliveredCount: live.deliveredCount,
        failedCount: live.failedCount,
        pendingCount: live.pendingCount,
        openedCount: live.openedCount,
        clickedCount: live.clickedCount,
        bouncedCount: live.bouncedCount || c.bouncedCount,
      };
    }),
  );

  const totals = {
    sent: liveTotals.sent,
    delivered: liveTotals.delivered,
    opened: liveTotals.opened,
    clicked: liveTotals.clicked,
    bounced: liveTotals.bounced,
    complained: liveTotals.complained,
  };

  const verifiedDomains = domains.filter((d) => d.status === 'VERIFIED');
  const avgReputation =
    domains.length > 0
      ? Math.round(domains.reduce((s, d) => s + d.reputationScore, 0) / domains.length)
      : 0;

  return {
    stats: {
      totalContacts,
      subscribedContacts,
      unsubscribedContacts,
      activeCampaigns,
      scheduledCampaigns,
      emailsSent: totals.delivered,
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
}

export function dashboardFingerprint(p: DashboardPayload): string {
  return [
    p.stats.totalContacts,
    p.stats.subscribedContacts,
    p.stats.emailsSent,
    p.stats.openRate,
    p.stats.clickRate,
    p.stats.activeCampaigns,
    ...p.recentCampaigns.map(
      (c) =>
        `${c.id}:${c.status}:${c.sentCount}:${c.pendingCount}:${c.openedCount}:${c.clickedCount}`,
    ),
  ].join('|');
}
