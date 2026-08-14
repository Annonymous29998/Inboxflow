import { prisma } from '../../config/prisma.js';
import { deliveredRecipientFilter, inboxDeliveredFilter } from './recipient-stats.js';
import { filterCountableClicks, isCountableOpen } from '../../utils/tracking-bot-filter.js';
import { countHumanClicks, countHumanOpens } from '../../services/tracking/recount.js';
import { normalizeBatchSize } from '../../services/email/queue-settings.js';

function asFiniteNumber(value: unknown, fallback: number | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export type SendActivityRow = {
  email: string;
  status: 'SENT' | 'FAILED' | 'BOUNCED' | 'OPENED' | 'CLICKED' | 'DELIVERED';
  error: string | null;
  at: string;
  url?: string | null;
};

export async function buildCampaignSendStatus(organizationId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, organizationId },
  });
  if (!campaign) return null;

  const [
    sentCount,
    failedCount,
    bouncedCount,
    pendingCount,
    deliveredCount,
    recentFailures,
    recentBounces,
    recentDelivered,
    openEvents,
    clickEvents,
    humanOpened,
    humanClicked,
    activeJob,
  ] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'BOUNCED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.count({ where: inboxDeliveredFilter(campaignId) }),
    prisma.campaignRecipient.findMany({
      where: { campaignId, status: 'FAILED' },
      include: { contact: { select: { email: true } } },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      take: 40,
    }),
    prisma.campaignRecipient.findMany({
      where: { campaignId, status: 'BOUNCED' },
      include: { contact: { select: { email: true } } },
      orderBy: [{ bouncedAt: 'desc' }, { sentAt: 'desc' }],
      take: 40,
    }),
    prisma.campaignRecipient.findMany({
      where: deliveredRecipientFilter(campaignId),
      include: { contact: { select: { email: true } } },
      orderBy: { sentAt: 'desc' },
      take: 40,
    }),
    prisma.trackingEvent.findMany({
      where: { campaignId, type: 'OPENED' },
      include: { contact: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 80,
    }),
    prisma.trackingEvent.findMany({
      where: { campaignId, type: 'CLICKED' },
      include: { contact: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 80,
    }),
    countHumanOpens(campaignId),
    countHumanClicks(campaignId),
    prisma.job.findFirst({
      where: {
        campaignId,
        type: 'CAMPAIGN_SEND',
        status: { in: ['RUNNING', 'PENDING', 'PAUSED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { meta: true },
    }),
  ]);

  const humanOpens = openEvents.filter((e) => isCountableOpen(e.userAgent, e.metadata));
  const verifiedOpenIds = new Set(
    humanOpens.map((e) => e.contactId).filter((id): id is string => Boolean(id)),
  );
  const countableClicks = filterCountableClicks(clickEvents, verifiedOpenIds);

  const sendActivity: SendActivityRow[] = [
    ...recentDelivered
      .filter((r) => r.status !== 'BOUNCED')
      .map((r) => ({
      email: r.contact.email,
      status: (r.status === 'DELIVERED' ? 'DELIVERED' : 'SENT') as 'SENT' | 'DELIVERED',
      error: null,
      at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
    })),
    ...recentFailures.map((r) => ({
      email: r.contact.email,
      status: 'FAILED' as const,
      error: r.error || 'Send failed',
      at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
    })),
    ...recentBounces.map((r) => ({
      email: r.contact.email,
      status: 'BOUNCED' as const,
      error: r.error || 'Rejected / bounced by provider',
      at: r.bouncedAt?.toISOString() || r.sentAt?.toISOString() || r.createdAt.toISOString(),
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const engagementActivity: SendActivityRow[] = [
    ...openEvents
      .filter((e) => isCountableOpen(e.userAgent, e.metadata))
      .slice(0, 40)
      .map((e) => ({
        email: e.contact?.email || 'unknown',
        status: 'OPENED' as const,
        error: null,
        at: e.createdAt.toISOString(),
      })),
    ...countableClicks.slice(0, 40).map((e) => ({
      email: e.contact?.email || 'unknown',
      status: 'CLICKED' as const,
      error: null,
      at: e.createdAt.toISOString(),
      url: e.url,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const recentSent = recentDelivered.slice(0, 12).map((r) => ({
    email: r.contact.email,
    at: r.sentAt,
  }));

  const lastSentEmail = sendActivity.find((a) => a.status === 'SENT' || a.status === 'DELIVERED')?.email ?? null;

  const jobMeta =
    activeJob?.meta && typeof activeJob.meta === 'object'
      ? (activeJob.meta as Record<string, unknown>)
      : {};
  const qs = (campaign.queueSettings && typeof campaign.queueSettings === 'object'
    ? campaign.queueSettings
    : {}) as { betweenEmailMs?: number; batchSize?: number; batchPauseMs?: number };
  const queueStage = typeof jobMeta.stage === 'string' ? jobMeta.stage : 'sending';
  const pauseUntil = typeof jobMeta.pauseUntil === 'string' ? jobMeta.pauseUntil : null;
  const betweenEmailMs =
    asFiniteNumber(jobMeta.betweenEmailMs, null) ?? asFiniteNumber(qs.betweenEmailMs, 4_000) ?? 4_000;
  const batchPauseMs =
    asFiniteNumber(jobMeta.batchPauseMs, null) ?? asFiniteNumber(qs.batchPauseMs, null);
  const batchNumber = asFiniteNumber(jobMeta.batchNumber, null);
  const queueBatchSize =
    normalizeBatchSize(asFiniteNumber(jobMeta.batchSize, null) ?? asFiniteNumber(qs.batchSize, 10));

  return {
    success: true,
    status: campaign.status,
    name: campaign.name,
    subject: campaign.subject,
    senderEmail: campaign.senderEmail,
    totalRecipients: campaign.totalRecipients,
    sentCount,
    /** SMTP accept confirmed by ESP (or engagement). Not the same as sentCount. */
    deliveredCount,
    failedCount,
    bouncedCount,
    pendingCount,
    openedCount: humanOpened,
    clickedCount: humanClicked,
    completedAt: campaign.completedAt,
    lastEmail: lastSentEmail,
    queueStage,
    pauseUntil,
    betweenEmailMs,
    batchPauseMs,
    batchNumber,
    queueBatchSize,
    recentSent,
    recentFailures: [
      ...recentFailures.slice(0, 40).map((r) => ({
        email: r.contact.email,
        error: r.error || 'Send failed',
      })),
      ...recentBounces.slice(0, 40).map((r) => ({
        email: r.contact.email,
        error: r.error || 'Rejected / bounced by provider',
      })),
    ].slice(0, 60),
    recentBounces: recentBounces.slice(0, 40).map((r) => ({
      email: r.contact.email,
      error: r.error || 'Rejected / bounced by provider',
    })),
    recentOpens: openEvents
      .filter((e) => isCountableOpen(e.userAgent, e.metadata))
      .slice(0, 20)
      .map((e) => ({
        email: e.contact?.email || 'unknown',
        at: e.createdAt.toISOString(),
      })),
    recentClicks: countableClicks.slice(0, 20).map((e) => ({
      email: e.contact?.email || 'unknown',
      at: e.createdAt.toISOString(),
      url: e.url,
    })),
    /** Send queue log — SENT / FAILED / BOUNCED / DELIVERED. */
    activity: sendActivity.slice(0, 100),
    engagementActivity,
  };
}
