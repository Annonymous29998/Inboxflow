import { prisma } from '../../config/prisma.js';
import { maybeFinalizeCampaignSend } from '../../services/email/campaign-finalize.js';
import { deliveredRecipientFilter, inboxDeliveredFilter, normalizeSentFailed } from './recipient-stats.js';
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

export async function buildCampaignSendStatus(
  organizationId: string,
  campaignId: string,
  opts?: { activityLimit?: number },
) {
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
    openedPeople,
    clickedPeople,
    engagedRecipients,
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
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(20, Math.min(8_000, opts?.activityLimit ?? 120)),
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
    prisma.campaignRecipient.count({ where: { campaignId, openedAt: { not: null } } }),
    prisma.campaignRecipient.count({ where: { campaignId, clickedAt: { not: null } } }),
    prisma.campaignRecipient.findMany({
      where: { campaignId, OR: [{ openedAt: { not: null } }, { clickedAt: { not: null } }] },
      select: {
        status: true,
        openedAt: true,
        clickedAt: true,
        contact: { select: { email: true } },
      },
      orderBy: [{ clickedAt: 'desc' }, { openedAt: 'desc' }],
    }),
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

  const logRows = [...processedRecipients].reverse();
  const sendActivity: SendActivityRow[] = logRows.map((r) => {
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
  const recentDelivered = logRows.filter((r) => r.status === 'SENT' || r.status === 'DELIVERED');
  const recentFailures = logRows.filter((r) => r.status === 'FAILED');
  const recentBounces = logRows.filter((r) => r.status === 'BOUNCED');

  const engagementList = engagedRecipients.map((row) => {
    const clicked = Boolean(row.clickedAt) || row.status === 'CLICKED';
    const opened = Boolean(row.openedAt) || clicked;
    return {
      email: row.contact.email,
      status: row.status,
      opened,
      clicked,
      openedAt: row.openedAt?.toISOString() ?? null,
      clickedAt: row.clickedAt?.toISOString() ?? null,
    };
  });
  const liveEngagement: SendActivityRow[] = engagedRecipients.flatMap((row) => {
    const lines: SendActivityRow[] = [];
    if (row.openedAt) {
      lines.push({
        email: row.contact.email,
        status: 'OPENED',
        error: null,
        at: row.openedAt.toISOString(),
      });
    }
    if (row.clickedAt) {
      lines.push({
        email: row.contact.email,
        status: 'CLICKED',
        error: null,
        at: row.clickedAt.toISOString(),
      });
    }
    return lines;
  });
  const engagementActivity: SendActivityRow[] = [
    ...aggregateEngagementRows(humanOpens, 'OPENED', 40),
    ...aggregateEngagementRows(countableClicks, 'CLICKED', 40),
    ...liveEngagement,
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  sendActivity.push(...liveEngagement);
  sendActivity.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const recentSent = recentDelivered.slice(-40).map((r) => ({
    email: r.contact.email,
    at: r.sentAt,
    smtpResponse: r.smtpResponse || null,
  }));

  const lastProcessedEmail =
    processedRecipients[0]?.contact.email ??
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
  const counts = normalizeSentFailed(sentCount, failedCount, campaign.totalRecipients);

  return {
    success: true,
    status: campaign.status,
    name: campaign.name,
    subject: campaign.subject,
    senderEmail: campaign.senderEmail,
    totalRecipients: campaign.totalRecipients,
    sentCount: counts.sent,
    /** SMTP accept confirmed by ESP (or engagement). Not the same as sentCount. */
    deliveredCount,
    failedCount: counts.failed,
    bouncedCount,
    pendingCount,
    openedCount: Math.max(humanOpened, openedPeople, campaign.openedCount || 0),
    clickedCount: Math.max(humanClicked, clickedPeople, campaign.clickedCount || 0),
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
    engagementList,
  };
}
