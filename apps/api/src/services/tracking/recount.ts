import { prisma } from '../../config/prisma.js';
import { filterCountableClicks, isCountableOpen } from '../../utils/tracking-bot-filter.js';

type TrackingRow = {
  contactId: string | null;
  createdAt: Date;
  userAgent: string | null;
  metadata: unknown;
};

async function loadUnsubscribeEvents(campaignId: string) {
  return prisma.trackingEvent.findMany({
    where: { campaignId, type: 'UNSUBSCRIBED', contactId: { not: null } },
    select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function loadOpenEvents(campaignId: string) {
  const [rows, unsubs] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: { campaignId, type: 'OPENED', contactId: { not: null } },
      select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    }),
    loadUnsubscribeEvents(campaignId),
  ]);
  const countable = rows.filter((e) => isCountableOpen(e.userAgent, e.metadata));
  return [...countable, ...unsubs] as TrackingRow[];
}

async function loadClickEvents(campaignId: string) {
  const [rows, unsubs] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: { campaignId, type: 'CLICKED', contactId: { not: null } },
      select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    }),
    loadUnsubscribeEvents(campaignId),
  ]);
  const clicks = filterCountableClicks(rows) as TrackingRow[];
  return [...clicks, ...(unsubs as TrackingRow[])];
}

/** Recompute campaign + recipient stats from verified human tracking only. */
export async function recountCampaignEngagement(campaignId: string) {
  const openEvents = await loadOpenEvents(campaignId);
  const clickEvents = await loadClickEvents(campaignId);

  const firstOpen = new Map<string, Date>();
  for (const e of openEvents) {
    if (e.contactId && !firstOpen.has(e.contactId)) firstOpen.set(e.contactId, e.createdAt);
  }

  const firstClick = new Map<string, Date>();
  for (const e of clickEvents) {
    if (e.contactId && !firstClick.has(e.contactId)) firstClick.set(e.contactId, e.createdAt);
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      openedCount: firstOpen.size,
      clickedCount: firstClick.size,
    },
  });

  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    select: { id: true, contactId: true, sentAt: true, status: true, deliveredAt: true },
  });

  for (const r of recipients) {
    const openedAt = firstOpen.get(r.contactId) ?? null;
    const clickedAt = firstClick.get(r.contactId) ?? null;
    // Click without open still means they engaged — only after scanner filter.
    const effectiveOpenedAt = openedAt || clickedAt;
    const wasDelivered =
      r.sentAt != null || ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(r.status);

    let status = r.status;
    if (r.status === 'UNSUBSCRIBED') status = 'UNSUBSCRIBED';
    else if (clickedAt) status = 'CLICKED';
    else if (effectiveOpenedAt) status = 'OPENED';
    else if (wasDelivered && ['OPENED', 'CLICKED'].includes(r.status)) status = 'SENT';

    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: {
        openedAt: effectiveOpenedAt,
        clickedAt,
        status,
        ...(clickedAt && !r.deliveredAt ? { deliveredAt: clickedAt } : {}),
      },
    });
  }

  return {
    openedCount: firstOpen.size,
    clickedCount: firstClick.size,
    openEvents: openEvents.length,
    clickEvents: clickEvents.length,
  };
}

/** Unique contacts with a countable open pixel, or a countable click (implied open). */
export async function countHumanOpens(campaignId: string): Promise<number> {
  const [openEvents, clickEvents] = await Promise.all([
    loadOpenEvents(campaignId),
    loadClickEvents(campaignId),
  ]);
  const people = new Set<string>();
  for (const e of openEvents) {
    if (e.contactId) people.add(e.contactId);
  }
  for (const e of clickEvents) {
    if (e.contactId) people.add(e.contactId);
  }
  return people.size;
}

export async function countHumanClicks(campaignId: string): Promise<number> {
  const clickEvents = await loadClickEvents(campaignId);
  return new Set(clickEvents.map((e) => e.contactId).filter(Boolean)).size;
}

export async function humanOpenCountByContact(
  campaignId: string,
  contactIds: string[],
): Promise<Record<string, number>> {
  if (!contactIds.length) return {};
  const [openEvents, clickEvents] = await Promise.all([
    loadOpenEvents(campaignId),
    loadClickEvents(campaignId),
  ]);
  const out: Record<string, number> = {};
  for (const e of openEvents) {
    if (e.contactId && contactIds.includes(e.contactId)) {
      out[e.contactId] = (out[e.contactId] ?? 0) + 1;
    }
  }
  const clickers = new Set(
    clickEvents.map((e) => e.contactId).filter((id): id is string => Boolean(id)),
  );
  for (const id of contactIds) {
    if ((out[id] ?? 0) === 0 && clickers.has(id)) out[id] = 1;
  }
  return out;
}

export async function humanClickCountByContact(
  campaignId: string,
  contactIds: string[],
): Promise<Record<string, number>> {
  if (!contactIds.length) return {};
  const events = await loadClickEvents(campaignId);
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.contactId && contactIds.includes(e.contactId)) {
      out[e.contactId] = (out[e.contactId] ?? 0) + 1;
    }
  }
  return out;
}

export async function humanEngagementByContact(
  campaignId: string,
  contactIds: string[],
): Promise<{
  openCount: Record<string, number>;
  clickCount: Record<string, number>;
  openedAt: Record<string, Date>;
  clickedAt: Record<string, Date>;
}> {
  if (!contactIds.length) {
    return { openCount: {}, clickCount: {}, openedAt: {}, clickedAt: {} };
  }
  const idSet = new Set(contactIds);
  const [openEvents, clickEvents] = await Promise.all([
    loadOpenEvents(campaignId),
    loadClickEvents(campaignId),
  ]);
  const openCount: Record<string, number> = {};
  const clickCount: Record<string, number> = {};
  const openedAt: Record<string, Date> = {};
  const clickedAt: Record<string, Date> = {};
  for (const e of openEvents) {
    if (!e.contactId || !idSet.has(e.contactId)) continue;
    openCount[e.contactId] = (openCount[e.contactId] ?? 0) + 1;
    if (!openedAt[e.contactId]) openedAt[e.contactId] = e.createdAt;
  }
  for (const e of clickEvents) {
    if (!e.contactId || !idSet.has(e.contactId)) continue;
    clickCount[e.contactId] = (clickCount[e.contactId] ?? 0) + 1;
    if (!clickedAt[e.contactId]) clickedAt[e.contactId] = e.createdAt;
    if (!openedAt[e.contactId]) openedAt[e.contactId] = e.createdAt;
    if ((openCount[e.contactId] ?? 0) === 0) openCount[e.contactId] = 1;
  }
  return { openCount, clickCount, openedAt, clickedAt };
}

const recountedCampaigns = new Set<string>();

/** Once per process after deploy so older campaigns get openedAt/clickedAt written back. */
export function maybeRecountCampaignEngagement(campaignId: string): void {
  if (recountedCampaigns.has(campaignId)) return;
  recountedCampaigns.add(campaignId);
  void recountCampaignEngagement(campaignId).catch((err) => {
    recountedCampaigns.delete(campaignId);
    console.error('recount engagement failed', campaignId, err);
  });
}
