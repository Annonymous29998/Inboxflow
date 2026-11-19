import { prisma } from '../../config/prisma.js';
import { deliveredRecipientFilter } from '../../modules/campaigns/recipient-stats.js';
import { pgmqSend } from '../queue/pgmq-client.js';
import { usesInProcessSend } from '../../config/db-kind.js';

const STALE_MS = 5 * 60_000;

async function queuedJobsForCampaign(campaignId: string): Promise<number> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pgmq."q_email-send" WHERE message->>'campaignId' = $1`,
      campaignId,
    )) as Array<{ n: number }>;
    return Number(rows[0]?.n || 0);
  } catch {
    return -1;
  }
}

async function requeueOrphans(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { providerId: true, organizationId: true },
  });
  if (!campaign) return;
  const orphans = await prisma.campaignRecipient.findMany({
    where: { campaignId, status: 'QUEUED' },
    select: { id: true, contactId: true, contact: { select: { email: true } } },
  });
  for (const row of orphans) {
    const to = row.contact?.email;
    if (!to) continue;
    await pgmqSend('email-send', {
      campaignId,
      recipientId: row.id,
      contactId: row.contactId,
      to,
      providerId: campaign.providerId,
      organizationId: campaign.organizationId,
    });
  }
}

/**
 * Flip SENDING → SENT (or FAILED) once nothing is left in QUEUED.
 * Must run after both successful and failed recipients — previously a failed
 * last email returned early and the campaign badge stayed SENDING forever.
 *
 * Also re-queues leftover QUEUED rows when the send queue is empty (jobs lost),
 * so a campaign cannot sit on SENDING after the last email.
 */
export async function maybeFinalizeCampaignSend(campaignId: string): Promise<'SENT' | 'FAILED' | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign || campaign.status !== 'SENDING') return null;

  const [delivered, failed, pending, lastSent] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.findFirst({
      where: { campaignId, sentAt: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
  ]);

  if (pending > 0) {
    const stale = !lastSent?.sentAt || Date.now() - lastSent.sentAt.getTime() > STALE_MS;
    if (stale) {
      if (usesInProcessSend()) return null;
      const inflight = await queuedJobsForCampaign(campaignId);
      if (inflight === 0) await requeueOrphans(campaignId);
    }
    return null;
  }
  if (delivered + failed === 0) return null;

  const nextStatus = failed > 0 && delivered === 0 ? 'FAILED' : 'SENT';
  const finishedAt = new Date();

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status: nextStatus,
      sentCount: delivered,
      failedCount: failed,
      completedAt: finishedAt,
    },
  });

  try {
    await prisma.job.updateMany({
      where: {
        campaignId,
        type: 'CAMPAIGN_SEND',
        status: { in: ['RUNNING', 'PENDING', 'PAUSED'] },
      },
      data: {
        status: nextStatus === 'FAILED' ? 'FAILED' : 'COMPLETED',
        processed: delivered + failed,
        finishedAt,
        meta: {
          stage: 'finalized',
          sent: delivered,
          failed,
          pending: 0,
        },
      },
    });
  } catch {
    /* job row is cosmetic */
  }

  return nextStatus;
}
