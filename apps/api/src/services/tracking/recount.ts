import { prisma } from '../../config/prisma.js';
import { filterCountableClicks, isCountableOpen } from '../../utils/tracking-bot-filter.js';

type TrackingRow = {
  contactId: string | null;
  createdAt: Date;
  userAgent: string | null;
  metadata: unknown;
};

async function loadOpenEvents(campaignId: string) {
  const rows = await prisma.trackingEvent.findMany({
    where: { campaignId, type: 'OPENED', contactId: { not: null } },
    select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((e) => isCountableOpen(e.userAgent, e.metadata)) as TrackingRow[];
}

async function loadClickEvents(campaignId: string) {
  const [rows, openEvents] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: { campaignId, type: 'CLICKED', contactId: { not: null } },
      select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    }),
    loadOpenEvents(campaignId),
  ]);
  const verifiedOpens = new Set(
    openEvents.map((e) => e.contactId).filter((id): id is string => Boolean(id)),
  );
  return filterCountableClicks(rows, verifiedOpens) as TrackingRow[];
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
    if (clickedAt) status = 'CLICKED';
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
