import { prisma } from '../../config/prisma.js';
import {
  deliveredRecipientFilter,
  sumDeliveredFromCounts,
} from '../../modules/campaigns/recipient-stats.js';
import { readLifetimeStats } from '../org-lifetime-stats.js';

export type CampaignLiveStats = {
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  pendingCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  totalRecipients?: number;
};

/** Live stats from recipient rows + verified tracking (not stale campaign counters). */
export async function getCampaignLiveStats(
  campaignId: string,
  totalRecipients?: number,
): Promise<CampaignLiveStats> {
  const [accepted, failed, pending, bounced, stored] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'BOUNCED' } }),
    prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        openedCount: true,
        clickedCount: true,
        bouncedCount: true,
      },
    }),
  ]);

  return {
    sentCount: Math.max(accepted, stored?.sentCount ?? 0),
    deliveredCount: Math.max(accepted, stored?.deliveredCount ?? 0, stored?.sentCount ?? 0),
    failedCount: Math.max(failed, stored?.failedCount ?? 0),
    pendingCount: pending,
    openedCount: stored?.openedCount ?? 0,
    clickedCount: stored?.clickedCount ?? 0,
    bouncedCount: Math.max(bounced, stored?.bouncedCount ?? 0),
    totalRecipients,
  };
}

type ListStat = {
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  pendingCount: number;
  bouncedCount: number;
  openedCount: number;
  clickedCount: number;
};

/** Batch recipient counts for a campaign list (few queries total, not 7 per row). */
export async function getCampaignsListStats(campaignIds: string[]): Promise<Map<string, ListStat>> {
  const out = new Map<string, ListStat>();
  if (!campaignIds.length) return out;

  // Do not load every TrackingEvent here — that made campaign list refresh stall.
  // Unique opens/clicks on the list come from stored campaign counters (updated on send/results).
  const [byStatus, storedRows] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.campaign.findMany({
      where: { id: { in: campaignIds } },
      select: {
        id: true,
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        openedCount: true,
        clickedCount: true,
        bouncedCount: true,
      },
    }),
  ]);

  type K = `${string}:${string}`;
  const counts = new Map<K, number>();
  for (const r of byStatus) {
    counts.set(`${r.campaignId}:${r.status}` as K, r._count._all);
  }
  const storedById = new Map(storedRows.map((c) => [c.id, c]));
  for (const id of campaignIds) {
    const stored = storedById.get(id);
    const sent = Math.max(sumDeliveredFromCounts(counts, id), stored?.sentCount ?? 0);
    out.set(id, {
      sentCount: sent,
      deliveredCount: Math.max(sent, stored?.deliveredCount ?? 0),
      failedCount: Math.max(counts.get(`${id}:FAILED` as K) ?? 0, stored?.failedCount ?? 0),
      pendingCount: counts.get(`${id}:QUEUED` as K) ?? 0,
      bouncedCount: Math.max(counts.get(`${id}:BOUNCED` as K) ?? 0, stored?.bouncedCount ?? 0),
      openedCount: stored?.openedCount ?? 0,
      clickedCount: stored?.clickedCount ?? 0,
    });
  }
  return out;
}

export async function getOrgLiveEngagement(organizationId: string) {
  const [agg, org] = await Promise.all([
    prisma.campaign.aggregate({
      where: {
        organizationId,
        status: { in: ['SENT', 'SENDING', 'PAUSED', 'CANCELLED', 'FAILED'] },
      },
      _sum: {
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        openedCount: true,
        clickedCount: true,
        bouncedCount: true,
        complainedCount: true,
      },
    }),
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { sendSettings: true },
    }),
  ]);
  const lifetime = readLifetimeStats(org?.sendSettings);
  const sum = agg._sum;
  const sent = (sum.sentCount ?? 0) + lifetime.sent;
  const delivered = Math.max(sum.deliveredCount ?? 0, sum.sentCount ?? 0) + lifetime.delivered;

  return {
    sent,
    delivered,
    failed: (sum.failedCount ?? 0) + lifetime.failed,
    opened: (sum.openedCount ?? 0) + lifetime.opened,
    clicked: (sum.clickedCount ?? 0) + lifetime.clicked,
    bounced: (sum.bouncedCount ?? 0) + lifetime.bounced,
    complained: (sum.complainedCount ?? 0) + lifetime.complained,
  };
}
