import { prisma } from '../../config/prisma.js';
import {
  deliveredRecipientFilter,
  inboxDeliveredFilter,
  INBOX_DELIVERED_STATUSES,
  sumDeliveredFromCounts,
} from '../../modules/campaigns/recipient-stats.js';
import { countHumanClicks, countHumanOpens } from '../tracking/recount.js';
import { isCountableClick, isCountableOpen } from '../../utils/tracking-bot-filter.js';

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
  const [accepted, inboxDelivered, failed, pending, bounced, opened, clicked] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: inboxDeliveredFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'BOUNCED' } }),
    countHumanOpens(campaignId),
    countHumanClicks(campaignId),
  ]);

  return {
    sentCount: accepted,
    deliveredCount: inboxDelivered,
    failedCount: failed,
    pendingCount: pending,
    openedCount: opened,
    clickedCount: clicked,
    bouncedCount: bounced,
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

  const [byStatus, inbox, openedRows, clickedRows, trackEvents] = await Promise.all([
    prisma.campaignRecipient.groupBy({
      by: ['campaignId', 'status'],
      where: { campaignId: { in: campaignIds } },
      _count: { _all: true },
    }),
    prisma.campaignRecipient.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        OR: [{ deliveredAt: { not: null } }, { status: { in: INBOX_DELIVERED_STATUSES } }],
      },
      _count: { _all: true },
    }),
    prisma.campaignRecipient.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        OR: [{ openedAt: { not: null } }, { status: { in: ['OPENED', 'CLICKED'] } }],
      },
      _count: { _all: true },
    }),
    prisma.campaignRecipient.groupBy({
      by: ['campaignId'],
      where: {
        campaignId: { in: campaignIds },
        OR: [{ clickedAt: { not: null } }, { status: 'CLICKED' }],
      },
      _count: { _all: true },
    }),
    prisma.trackingEvent.findMany({
      where: {
        campaignId: { in: campaignIds },
        type: { in: ['OPENED', 'CLICKED'] },
        contactId: { not: null },
      },
      select: { campaignId: true, contactId: true, type: true, userAgent: true, metadata: true },
    }),
  ]);

  type K = `${string}:${string}`;
  const counts = new Map<K, number>();
  for (const r of byStatus) {
    counts.set(`${r.campaignId}:${r.status}` as K, r._count._all);
  }
  const inboxById = new Map(inbox.map((r) => [r.campaignId, r._count._all]));
  const openedById = new Map(openedRows.map((r) => [r.campaignId, r._count._all]));
  const clickedById = new Map(clickedRows.map((r) => [r.campaignId, r._count._all]));

  const eventOpened = new Map<string, Set<string>>();
  const eventClicked = new Map<string, Set<string>>();
  for (const e of trackEvents) {
    if (!e.contactId || !e.campaignId) continue;
    if (e.type === 'CLICKED' && isCountableClick(e.userAgent, e.metadata)) {
      if (!eventClicked.has(e.campaignId)) eventClicked.set(e.campaignId, new Set());
      eventClicked.get(e.campaignId)!.add(e.contactId);
      if (!eventOpened.has(e.campaignId)) eventOpened.set(e.campaignId, new Set());
      eventOpened.get(e.campaignId)!.add(e.contactId);
    } else if (e.type === 'OPENED' && isCountableOpen(e.userAgent, e.metadata)) {
      if (!eventOpened.has(e.campaignId)) eventOpened.set(e.campaignId, new Set());
      eventOpened.get(e.campaignId)!.add(e.contactId);
    }
  }

  for (const id of campaignIds) {
    out.set(id, {
      sentCount: sumDeliveredFromCounts(counts, id),
      deliveredCount: inboxById.get(id) ?? 0,
      failedCount: counts.get(`${id}:FAILED` as K) ?? 0,
      pendingCount: counts.get(`${id}:QUEUED` as K) ?? 0,
      bouncedCount: counts.get(`${id}:BOUNCED` as K) ?? 0,
      openedCount: Math.max(openedById.get(id) ?? 0, eventOpened.get(id)?.size ?? 0),
      clickedCount: Math.max(clickedById.get(id) ?? 0, eventClicked.get(id)?.size ?? 0),
    });
  }
  return out;
}

export async function getOrgLiveEngagement(organizationId: string) {
  const campaigns = await prisma.campaign.findMany({
    where: {
      organizationId,
      status: { in: ['SENT', 'SENDING', 'PAUSED', 'CANCELLED', 'FAILED'] },
    },
    select: { id: true },
  });

  const ids = campaigns.map((c) => c.id);
  if (!ids.length) {
    return { sent: 0, delivered: 0, failed: 0, opened: 0, clicked: 0, bounced: 0, complained: 0 };
  }

  const [deliveredCount, failed, bounced, complainedAgg] = await Promise.all([
    prisma.campaignRecipient.count({
      where: {
        campaignId: { in: ids },
        status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'] },
      },
    }),
    prisma.campaignRecipient.count({ where: { campaignId: { in: ids }, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId: { in: ids }, status: 'BOUNCED' } }),
    prisma.campaign.aggregate({
      where: { organizationId, id: { in: ids } },
      _sum: { complainedCount: true },
    }),
  ]);

  let opened = 0;
  let clicked = 0;
  for (const id of ids) {
    opened += await countHumanOpens(id);
    clicked += await countHumanClicks(id);
  }

  return {
    sent: deliveredCount + failed,
    delivered: deliveredCount,
    failed,
    opened,
    clicked,
    bounced,
    complained: complainedAgg._sum.complainedCount ?? 0,
  };
}
