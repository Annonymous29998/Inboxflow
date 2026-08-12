import { prisma } from '../../config/prisma.js';
import { deliveredRecipientFilter } from '../../modules/campaigns/recipient-stats.js';
import { countHumanClicks, countHumanOpens } from '../tracking/recount.js';

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
  const [delivered, failed, pending, bounced, opened, clicked] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'BOUNCED' } }),
    countHumanOpens(campaignId),
    countHumanClicks(campaignId),
  ]);

  return {
    sentCount: delivered,
    deliveredCount: delivered,
    failedCount: failed,
    pendingCount: pending,
    openedCount: opened,
    clickedCount: clicked,
    bouncedCount: bounced,
    totalRecipients,
  };
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
