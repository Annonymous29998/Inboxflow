import { prisma } from '../../config/prisma.js';
import {
  deliveredRecipientFilter,
  inboxDeliveredFilter,
  INBOX_DELIVERED_STATUSES,
  sumDeliveredFromCounts,
} from '../../modules/campaigns/recipient-stats.js';
import { countHumanClicks, countHumanOpens } from '../tracking/recount.js';
import { filterCountableClicks, isCountableOpen } from '../../utils/tracking-bot-filter.js';

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

  const [byStatus, inbox, trackEvents] = await Promise.all([
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
    prisma.trackingEvent.findMany({
      where: {
        campaignId: { in: campaignIds },
        type: { in: ['OPENED', 'CLICKED', 'UNSUBSCRIBED'] },
        contactId: { not: null },
      },
      select: {
        campaignId: true,
        contactId: true,
        type: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
    }),
  ]);

  type K = `${string}:${string}`;
  const counts = new Map<K, number>();
  for (const r of byStatus) {
    counts.set(`${r.campaignId}:${r.status}` as K, r._count._all);
  }
  const inboxById = new Map(inbox.map((r) => [r.campaignId, r._count._all]));

  const eventOpened = new Map<string, Set<string>>();
  const eventClicked = new Map<string, Set<string>>();
  const opensByCampaign = new Map<string, Set<string>>();
  for (const e of trackEvents) {
    if (!e.contactId || !e.campaignId || e.type !== 'OPENED') continue;
    if (!isCountableOpen(e.userAgent, e.metadata)) continue;
    if (!opensByCampaign.has(e.campaignId)) opensByCampaign.set(e.campaignId, new Set());
    opensByCampaign.get(e.campaignId)!.add(e.contactId);
  }
  const clicksByCampaign = new Map<string, typeof trackEvents>();
  for (const e of trackEvents) {
    if (!e.contactId || !e.campaignId || e.type !== 'CLICKED') continue;
    const list = clicksByCampaign.get(e.campaignId) ?? [];
    list.push(e);
    clicksByCampaign.set(e.campaignId, list);
  }
  for (const [campaignId, opens] of opensByCampaign) {
    eventOpened.set(campaignId, new Set(opens));
  }
  for (const [campaignId, clicks] of clicksByCampaign) {
    const verified = opensByCampaign.get(campaignId) ?? new Set<string>();
    const human = filterCountableClicks(clicks, verified);
    if (!eventClicked.has(campaignId)) eventClicked.set(campaignId, new Set());
    if (!eventOpened.has(campaignId)) eventOpened.set(campaignId, new Set());
    for (const e of human) {
      if (!e.contactId) continue;
      eventClicked.get(campaignId)!.add(e.contactId);
      eventOpened.get(campaignId)!.add(e.contactId);
    }
  }
  for (const e of trackEvents) {
    if (!e.contactId || !e.campaignId || e.type !== 'UNSUBSCRIBED') continue;
    if (!eventOpened.has(e.campaignId)) eventOpened.set(e.campaignId, new Set());
    if (!eventClicked.has(e.campaignId)) eventClicked.set(e.campaignId, new Set());
    eventOpened.get(e.campaignId)!.add(e.contactId);
    eventClicked.get(e.campaignId)!.add(e.contactId);
  }

  for (const id of campaignIds) {
    out.set(id, {
      sentCount: sumDeliveredFromCounts(counts, id),
      deliveredCount: inboxById.get(id) ?? 0,
      failedCount: counts.get(`${id}:FAILED` as K) ?? 0,
      pendingCount: counts.get(`${id}:QUEUED` as K) ?? 0,
      bouncedCount: counts.get(`${id}:BOUNCED` as K) ?? 0,
      openedCount: eventOpened.get(id)?.size ?? 0,
      clickedCount: eventClicked.get(id)?.size ?? 0,
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
