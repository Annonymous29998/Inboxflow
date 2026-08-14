import type { EventType, Prisma } from '@prisma/client';

/**
 * Left our SMTP successfully at some point (may later bounce or engage).
 * Includes BOUNCED so progress/sent counts don't drop when ESP reports a rejection.
 */
export const DELIVERED_RECIPIENT_STATUSES: EventType[] = [
  'SENT',
  'DELIVERED',
  'OPENED',
  'CLICKED',
  'BOUNCED',
];

/** Confirmed inbox delivery (ESP delivered webhook, or engagement that implies delivery). */
export const INBOX_DELIVERED_STATUSES: EventType[] = ['DELIVERED', 'OPENED', 'CLICKED'];

export function deliveredRecipientFilter(campaignId: string): Prisma.CampaignRecipientWhereInput {
  return { campaignId, status: { in: DELIVERED_RECIPIENT_STATUSES } };
}

/** True delivery — not merely SMTP accept (SENT). */
export function inboxDeliveredFilter(campaignId: string): Prisma.CampaignRecipientWhereInput {
  return {
    campaignId,
    OR: [
      { deliveredAt: { not: null } },
      { status: { in: INBOX_DELIVERED_STATUSES } },
    ],
  };
}

/** Sum live recipient rows that left SMTP (includes OPENED/CLICKED/BOUNCED). */
export function sumDeliveredFromCounts(
  counts: Map<string, number>,
  campaignId: string,
): number {
  let sum = 0;
  for (const st of DELIVERED_RECIPIENT_STATUSES) {
    sum += counts.get(`${campaignId}:${st}`) ?? 0;
  }
  return sum;
}
