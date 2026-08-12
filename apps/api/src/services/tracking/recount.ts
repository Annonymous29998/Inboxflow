import { prisma } from '../../config/prisma.js';
import { isHumanTrackingEvent } from '../../utils/tracking-bot-filter.js';

type TrackingRow = {
  contactId: string | null;
  createdAt: Date;
  userAgent: string | null;
  metadata: unknown;
};

async function loadHumanEvents(campaignId: string, type: 'OPENED' | 'CLICKED') {
  const rows = await prisma.trackingEvent.findMany({
    where: { campaignId, type, contactId: { not: null } },
    select: { contactId: true, createdAt: true, userAgent: true, metadata: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((e) => isHumanTrackingEvent(e.userAgent, e.metadata)) as TrackingRow[];
}

/** Recompute campaign + recipient open/click stats from human-only tracking events. */
export async function recountCampaignEngagement(campaignId: string) {
  const [openEvents, clickEvents] = await Promise.all([
    loadHumanEvents(campaignId, 'OPENED'),
    loadHumanEvents(campaignId, 'CLICKED'),
  ]);

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
    select: { id: true, contactId: true, sentAt: true, status: true },
  });

  for (const r of recipients) {
    const openedAt = firstOpen.get(r.contactId) ?? null;
    const clickedAt = firstClick.get(r.contactId) ?? null;
    const wasDelivered =
      r.sentAt != null || ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'].includes(r.status);

    let status = r.status;
    if (clickedAt) status = 'CLICKED';
    else if (openedAt) status = 'OPENED';
    else if (wasDelivered && ['OPENED', 'CLICKED'].includes(r.status)) status = 'SENT';

    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { openedAt, clickedAt, status },
    });
  }

  return {
    openedCount: firstOpen.size,
    clickedCount: firstClick.size,
    openEvents: openEvents.length,
    clickEvents: clickEvents.length,
  };
}

export async function countHumanOpens(campaignId: string): Promise<number> {
  const events = await loadHumanEvents(campaignId, 'OPENED');
  return new Set(events.map((e) => e.contactId).filter(Boolean)).size;
}

export async function countHumanClicks(campaignId: string): Promise<number> {
  const events = await loadHumanEvents(campaignId, 'CLICKED');
  return new Set(events.map((e) => e.contactId).filter(Boolean)).size;
}

export async function humanOpenCountByContact(
  campaignId: string,
  contactIds: string[],
): Promise<Record<string, number>> {
  if (!contactIds.length) return {};
  const events = await loadHumanEvents(campaignId, 'OPENED');
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.contactId && contactIds.includes(e.contactId)) {
      out[e.contactId] = (out[e.contactId] ?? 0) + 1;
    }
  }
  return out;
}

export async function humanClickCountByContact(
  campaignId: string,
  contactIds: string[],
): Promise<Record<string, number>> {
  if (!contactIds.length) return {};
  const events = await loadHumanEvents(campaignId, 'CLICKED');
  const out: Record<string, number> = {};
  for (const e of events) {
    if (e.contactId && contactIds.includes(e.contactId)) {
      out[e.contactId] = (out[e.contactId] ?? 0) + 1;
    }
  }
  return out;
}
