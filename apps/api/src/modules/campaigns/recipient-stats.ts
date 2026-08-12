import type { EventType, Prisma } from '@prisma/client';

/** Recipient rows that successfully left our SMTP (may later become OPENED/CLICKED). */
export const DELIVERED_RECIPIENT_STATUSES: EventType[] = ['SENT', 'DELIVERED', 'OPENED', 'CLICKED'];

export function deliveredRecipientFilter(campaignId: string): Prisma.CampaignRecipientWhereInput {
  return { campaignId, status: { in: DELIVERED_RECIPIENT_STATUSES } };
}
