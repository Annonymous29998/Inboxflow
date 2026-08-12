import type { EventType, Prisma } from '@prisma/client';

/** Recipient rows that successfully left our SMTP (may later become OPENED/CLICKED). */
export const DELIVERED_RECIPIENT_STATUSES: EventType[] = ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'];

export function deliveredRecipientFilter(campaignId: string): Prisma.CampaignRecipientWhereInput {
  return { campaignId, status: { in: DELIVERED_RECIPIENT_STATUSES } };
}

/** Sum live recipient rows that left SMTP (includes OPENED/CLICKED). */
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
