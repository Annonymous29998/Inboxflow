import { prisma } from '../../config/prisma.js';
import { maybeFinalizeCampaignSend } from '../../services/email/campaign-finalize.js';
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
  /** How many times this contact opened/clicked (campaign totals stay unique people). */
  times?: number;
};

function aggregateEngagementRows(
  events: Array<{
    contactId: string | null;
    createdAt: Date;
    url?: string | null;
    contact?: { email: string } | null;
  }>,
  status: 'OPENED' | 'CLICKED',
  limit = 40,
): SendActivityRow[] {
  type Agg = { email: string; at: Date; times: number; url?: string | null };
  const byContact = new Map<string, Agg>();
  for (const e of events) {
    const key = e.contactId || e.contact?.email || 'unknown';
    const email = e.contact?.email || 'unknown';
    const prev = byContact.get(key);
    if (!prev) {
      byContact.set(key, { email, at: e.createdAt, times: 1, url: e.url ?? null });
      continue;
    }
    prev.times += 1;
    if (e.createdAt > prev.at) {
      prev.at = e.createdAt;
      if (e.url) prev.url = e.url;
    }
  }
  return [...byContact.values()]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      email: r.email,
      status,
      error: null,
      at: r.at.toISOString(),
      url: r.url,
      times: r.times,
    }));
}

export async function buildCampaignSendStatus(organizationId: string, campaignId: string) {
  let campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, organizationId },
  });
  if (!campaign) return null;
  if (campaign.status === 'SENDING') {
    const flipped = await maybeFinalizeCampaignSend(campaignId);
    if (flipped) {
      campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, organizationId },
      });
      if (!campaign) return null;
    }
  }

  const [
    sentCount,
    failedCount,
    bouncedCount,
    pendingCount,
    deliveredCount,
    processedRecipients,
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
      where: {
        campaignId,
        status: { in: ['SENT', 'FAILED', 'BOUNCED', 'DELIVERED'] },
      },
      select: {
        status: true,
        error: true,
        smtpResponse: true,
        sentAt: true,
        bouncedAt: true,
        createdAt: true,
        contact: { select: { email: true } },
      },
      orderBy: [{ sentAt: 'asc' }, { createdAt: 'asc' }],
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
      select: { id: true, meta: true },
    }),
  ]);

  const humanOpens = openEvents.filter((e) => isCountableOpen(e.userAgent, e.metadata));
  const verifiedOpenIds = new Set(
    humanOpens.map((e) => e.contactId).filter((id): id is string => Boolean(id)),
  );
  const countableClicks = filterCountableClicks(clickEvents, verifiedOpenIds);

  const sendActivity: SendActivityRow[] = processedRecipients.map((r) => {
    if (r.status === 'FAILED') {
      return {
        email: r.contact.email,
        status: 'FAILED' as const,
        error: r.error || 'Send failed',
        at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
      };
    }
    if (r.status === 'BOUNCED') {
      return {
        email: r.contact.email,
        status: 'BOUNCED' as const,
        error: r.error || 'Rejected / bounced by provider',
        at: r.bouncedAt?.toISOString() || r.sentAt?.toISOString() || r.createdAt.toISOString(),
      };
    }
    return {
      email: r.contact.email,
      status: (r.status === 'DELIVERED' ? 'DELIVERED' : 'SENT') as 'SENT' | 'DELIVERED',
      error: r.smtpResponse || null,
      at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
    };
  });
  const recentDelivered = processedRecipients.filter(
    (r) => r.status === 'SENT' || r.status === 'DELIVERED',
  );
  const recentFailures = processedRecipients.filter((r) => r.status === 'FAILED');
  const recentBounces = processedRecipients.filter((r) => r.status === 'BOUNCED');

  const engagementActivity: SendActivityRow[] = [
    ...aggregateEngagementRows(humanOpens, 'OPENED', 40),
    ...aggregateEngagementRows(countableClicks, 'CLICKED', 40),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));

  const recentSent = recentDelivered.map((r) => ({
    email: r.contact.email,
    at: r.sentAt,
    smtpResponse: r.smtpResponse || null,
  }));

  const lastProcessedEmail =
    processedRecipients.at(-1)?.contact.email ??
    [...sendActivity].reverse().find((a) => a.status === 'SENT' || a.status === 'DELIVERED')?.email ??
    null;

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
    asFiniteNumber(jobMeta.betweenEmailMs, null) ?? asFiniteNumber(qs.betweenEmailMs, 1_500) ?? 1_500;
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
    jobId: activeJob?.id ?? null,
    lastEmail:
      (typeof jobMeta.lastEmail === 'string' && jobMeta.lastEmail) || lastProcessedEmail,
    queueStage,
    pauseUntil,
    betweenEmailMs,
    batchPauseMs,
    batchNumber,
    queueBatchSize,
    recentSent,
    recentFailures: [
      ...recentFailures.map((r) => ({
        email: r.contact.email,
        error: r.error || 'Send failed',
      })),
      ...recentBounces.map((r) => ({
        email: r.contact.email,
        error: r.error || 'Rejected / bounced by provider',
      })),
    ],
    recentBounces: recentBounces.map((r) => ({
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
    /** Full send log for this campaign only — SENT / FAILED / BOUNCED / DELIVERED. */
    activity: sendActivity,
    engagementActivity,
  };
}
