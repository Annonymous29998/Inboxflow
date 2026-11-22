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

/**
 * Sent = SMTP accepted. Failed is separate.
 * If a stale counter stored processed (sent+failed) as sentCount, peel failures off.
 */
export function normalizeSentFailed(sent: number, failed: number, total?: number | null) {
  const f = Math.max(0, Math.floor(Number(failed) || 0));
  let s = Math.max(0, Math.floor(Number(sent) || 0));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  if (f > 0 && t > 0 && s >= t) s = Math.max(0, t - f);
  else if (f > 0 && t > 0 && s + f > t && s > t - f) s = Math.max(0, t - f);
  return { sent: s, failed: f };
}
