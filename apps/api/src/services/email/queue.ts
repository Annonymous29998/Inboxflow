import {
  ensurePgmqQueues,
  pgmqArchive,
  pgmqArchiveByCampaign,
  pgmqDelete,
  pgmqRead,
  pgmqReadFairByOrg,
  pgmqSend,
  pgmqSetVt,
  sleep,
  type QueueName,
} from '../queue/pgmq-client.js';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { Prisma } from '@prisma/client';
import { analyzeCampaign } from '../../modules/deliverability/analyzer.js';
import { scrubCampaignContent, findRemainingSpamPhrases, stripHtmlTags, isImageOnlyHtml } from '../../modules/deliverability/spam-scrubber.js';
import { sendCampaignEmailToRecipient } from './campaign-send.js';
import { syncRecipientIssue } from './recipient-guard.js';
import { deliveredRecipientFilter } from '../../modules/campaigns/recipient-stats.js';
import {
  DEFAULT_BATCH_PAUSE_MS,
  DEFAULT_BETWEEN_EMAIL_MS,
  normalizeBatchSize,
  normalizeMaxPerMinute,
  withRecommendedPacing,
} from './queue-settings.js';
import {
  throttleAttemptsLeft,
  throttleRetryMs,
  isSmtpAccountBlockError,
  SMTP_BLOCK_STREAK_LIMIT,
} from './smtp-throttle.js';
import { maybeFinalizeCampaignSend } from './campaign-finalize.js';
import { writeSystemLog } from '../system-log.js';
import { usesInProcessSend } from '../../config/db-kind.js';

/** Consecutive 535/554 replies for the in-process worker (single PM2 fork). */
const smtpBlockStreak = new Map<string, number>();

export type EmailJobData = {
  campaignId: string;
  recipientId: string;
  contactId: string;
  to: string;
  attempt?: number;
  providerId?: string | null;
  organizationId?: string;
};

export type CampaignJobData = {
  campaignId: string;
};

export type BounceJobData = {
  email: string;
  type: 'HARD' | 'SOFT';
  organizationId: string;
  campaignId?: string;
  recipientId?: string;
  contactId?: string;
  messageId?: string;
  reason?: string;
};

const MAX_ATTEMPTS = env.MAX_RETRY_ATTEMPTS;
const VISIBILITY_SEC = 300;

export async function enqueueCampaign(campaignId: string) {
  smtpBlockStreak.set(campaignId, 0);
  if (usesInProcessSend()) {
    const { startLocalCampaignSend } = await import('./local-campaign-send.js');
    startLocalCampaignSend(campaignId);
    return;
  }
  await pgmqSend<CampaignJobData>('campaign-dispatch', { campaignId });
}

export async function enqueueCampaignScheduled(campaignId: string, delayMs: number) {
  const delaySeconds = Math.max(0, Math.ceil(delayMs / 1000));
  await pgmqSend<CampaignJobData>('campaign-dispatch', { campaignId }, delaySeconds);
}

export async function enqueueBounce(data: BounceJobData) {
  await pgmqSend<BounceJobData>('bounce-process', data);
}

export async function drainCampaignJobs(campaignId: string) {
  if (usesInProcessSend()) return;
  await pgmqArchiveByCampaign('email-send', campaignId);
}

/** Re-queue still-subscribed recipients. Keep unique open/click timestamps so engagement merges. */
export async function resetCampaignForResend(campaignId: string, contactIds?: string[]): Promise<number> {
  await drainCampaignJobs(campaignId);
  const reset = await prisma.campaignRecipient.updateMany({
    where: {
      campaignId,
      ...(contactIds?.length ? { contactId: { in: contactIds } } : {}),
      status: { notIn: ['UNSUBSCRIBED', 'COMPLAINED'] },
      contact: { status: 'SUBSCRIBED' },
    },
    data: {
      status: 'QUEUED',
      error: null,
      messageId: null,
      sentAt: null,
      deliveredAt: null,
      bouncedAt: null,
    },
  });
  return reset.count;
}

async function handleJobFailure(queue: QueueName, msgId: bigint, readCt: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Queue ${queue} job ${msgId} failed (attempt ${readCt}):`, message);
  if (readCt >= MAX_ATTEMPTS) {
    await pgmqArchive(queue, msgId);
  }
}

export function startWorkers() {
  if (usesInProcessSend()) {
    void import('./local-campaign-send.js').then((m) => m.startLocalSendSupervisor());
    console.log('Workers started: in-process sequential send (desktop / RDP)');
    return { stop: () => {} };
  }
  void ensurePgmqQueues().then(() => {
    void runCampaignWorker();
    void runEmailWorker();
    void runBounceWorker();
    console.log(
      `Workers started: campaign-dispatch, email-send (parallel orgs=${env.EMAIL_PARALLEL_ORGS}), bounce-process`,
    );
  });

  return { stop: () => {} };
}

async function runCampaignWorker() {
  for (;;) {
    try {
      const batch = await pgmqRead<CampaignJobData>('campaign-dispatch', VISIBILITY_SEC, 2);
      if (!batch.length) {
        await sleep(1000);
        continue;
      }

      await Promise.all(
        batch.map(async (row) => {
          try {
            await dispatchCampaign(row.message.campaignId);
            await pgmqDelete('campaign-dispatch', row.msg_id);
          } catch (err) {
            await handleJobFailure('campaign-dispatch', row.msg_id, row.read_ct, err);
          }
        }),
      );
    } catch (err) {
      console.error('Campaign worker error:', err);
      await sleep(2000);
    }
  }
}

async function runEmailWorker() {
  const parallelOrgs = Math.max(1, Math.min(32, env.EMAIL_PARALLEL_ORGS || 8));

  for (;;) {
    try {
      const batch = await pgmqReadFairByOrg<EmailJobData>('email-send', VISIBILITY_SEC, parallelOrgs, 1);
      if (!batch.length) {
        await sleep(400);
        continue;
      }

      await Promise.all(
        batch.map(async (row) => {
          try {
            await processEmailJob(row.message);
            await pgmqDelete('email-send', row.msg_id);
          } catch (err) {
            await handleJobFailure('email-send', row.msg_id, row.read_ct, err);
          }
        }),
      );
    } catch (err) {
      console.error('Email worker error:', err);
      await sleep(2000);
    }
  }
}

async function runBounceWorker() {
  for (;;) {
    try {
      const batch = await pgmqRead<BounceJobData>('bounce-process', VISIBILITY_SEC, 5);
      if (!batch.length) {
        await sleep(1000);
        continue;
      }

      await Promise.all(
        batch.map(async (row) => {
          try {
            await processBounce(row.message);
            await pgmqDelete('bounce-process', row.msg_id);
          } catch (err) {
            await handleJobFailure('bounce-process', row.msg_id, row.read_ct, err);
          }
        }),
      );
    } catch (err) {
      console.error('Bounce worker error:', err);
      await sleep(2000);
    }
  }
}

export async function dispatchCampaign(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      organization: true,
      list: { include: { members: { include: { contact: true } } } },
      domain: true,
      provider: true,
    },
  });

  if (!campaign) throw new Error('Campaign not found');
  if (!['READY', 'SCHEDULED', 'SENDING'].includes(campaign.status)) {
    throw new Error(`Campaign status ${campaign.status} cannot send`);
  }

  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now()) {
    return;
  }

  // Final LAST-RESORT gate: scrub spam phrases regardless of how campaign was saved
  // (handles old campaigns created before scrubber existed / edge functions / API bypass / manual DB edits)
  const scrubbed = scrubCampaignContent({
    subject: campaign.subject,
    previewText: campaign.previewText,
    htmlContent: campaign.htmlContent,
    plainTextContent: campaign.plainTextContent,
  });
  const remainingSpam = findRemainingSpamPhrases(
    `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.plainTextContent}\n${stripHtmlTags(scrubbed.htmlContent)}`,
  );
  const imageOnly = scrubbed.htmlContent && isImageOnlyHtml(scrubbed.htmlContent);
  const emptySubject = !scrubbed.subject.trim();

  // Unsubscribe is recommended (analyzer warns) but must not hard-block sends.
  if (emptySubject || imageOnly || remainingSpam.length > 0) {
    const blockers: string[] = [];
    if (emptySubject) blockers.push('empty subject');
    if (imageOnly) blockers.push('image-only content (no readable text)');
    if (remainingSpam.length > 0) blockers.push(`remaining high-risk spam phrases: ${remainingSpam.join(', ')}`);
    const failText = `Send cancelled by content filter. Fix: ${blockers.join('; ')}`;

    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
      },
    });
    try {
      await prisma.job.create({
        data: {
          organizationId: campaign.organizationId,
          campaignId,
          type: 'CAMPAIGN_SEND',
          status: 'FAILED',
          total: 0,
          processed: 0,
          error: failText,
          meta: { blockers },
        },
      });
    } catch { /* ignore job write failures */ }
    throw new Error(`Campaign blocked by send-side content filter: ${blockers.join('; ')}`);
  }

  let subject: string = scrubbed.subject;
  let previewText: string | null = scrubbed.previewText;
  let htmlContent: string | null = scrubbed.htmlContent;
  let plainTextContent: string | null = scrubbed.plainTextContent;
  if (scrubbed.changed) {
    const updated = await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        subject,
        previewText,
        htmlContent,
        plainTextContent,
      },
    });
    campaign.subject = updated.subject;
    campaign.previewText = updated.previewText;
    campaign.htmlContent = updated.htmlContent;
    campaign.plainTextContent = updated.plainTextContent;
  }

  const report = analyzeCampaign({
    subject: campaign.subject,
    previewText: campaign.previewText,
    htmlContent: campaign.htmlContent,
    plainTextContent: campaign.plainTextContent,
    senderName: campaign.senderName,
    senderEmail: campaign.senderEmail,
    physicalAddress: campaign.organization.physicalAddress,
    authStatus: campaign.domain
      ? {
          spf: campaign.domain.spfValid,
          dkim: campaign.domain.dkimValid,
          dmarc: campaign.domain.dmarcValid,
          bimi: campaign.domain.bimiValid,
        }
      : undefined,
  });

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      deliverabilityScore: report.score,
      inboxReadinessScore: report.inboxReadiness.overall,
      analysisReport: report as object,
      status: 'SENDING',
      sentAt: new Date(),
    },
  });

  let contacts =
    campaign.list?.members.map((m) => m.contact).filter((c) => c.status === 'SUBSCRIBED') ?? [];

  if (campaign.segmentId) {
    const segment = await prisma.segment.findUnique({ where: { id: campaign.segmentId } });
    if (segment) {
      contacts = await resolveSegmentContacts(campaign.organizationId, segment.rules as SegmentRules);
    }
  }

  const suppressed = await prisma.suppressionList.findMany({
    where: {
      organizationId: campaign.organizationId,
      email: { in: contacts.map((c) => c.email) },
    },
    select: { email: true },
  });
  const suppressedSet = new Set(suppressed.map((s) => s.email.toLowerCase()));
  contacts = contacts.filter(
    (c) => !suppressedSet.has(c.email.toLowerCase()) && syncRecipientIssue(c.email).ok,
  );

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: contacts.length },
  });
  try {
    const { upsertJobProgress } = await import('../../modules/jobs/progress.js');
    const job = await prisma.job.findFirst({
      where: {
        campaignId,
        type: 'CAMPAIGN_SEND',
        status: { in: ['RUNNING', 'PENDING', 'PAUSED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, organizationId: true, processed: true, meta: true },
    });
    if (job) {
      await upsertJobProgress({
        id: job.id,
        type: 'CAMPAIGN_SEND',
        organizationId: job.organizationId,
        campaignId,
        status: 'RUNNING',
        total: contacts.length,
        processed: job.processed,
        meta: job.meta as Prisma.InputJsonValue,
      });
    }
  } catch {
    /* progress must not block queue */
  }

  const queueSettings = withRecommendedPacing(campaign.queueSettings);
  const batchSize = queueSettings.batchSize;
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { queueSettings: queueSettings as object },
  });

  // Enqueue only recipients that still need sending. Never reset SENT back to QUEUED
  // (Retry failed / Resume used to re-dispatch the whole list and could duplicate sends).
  for (let i = 0; i < contacts.length; i += batchSize) {
    const live = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!live || ['PAUSED', 'CANCELLED'].includes(live.status)) {
      return;
    }

    const batch = contacts.slice(i, i + batchSize);
    for (let idx = 0; idx < batch.length; idx += 1) {
      const contact = batch[idx]!;
      const existing = await prisma.campaignRecipient.findUnique({
        where: {
          campaignId_contactId: { campaignId, contactId: contact.id },
        },
      });

      if (
        existing &&
        ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED'].includes(
          existing.status,
        )
      ) {
        continue;
      }

      const recipient =
        existing?.status === 'QUEUED'
          ? existing
          : await prisma.campaignRecipient.upsert({
              where: {
                campaignId_contactId: { campaignId, contactId: contact.id },
              },
              create: {
                campaignId,
                contactId: contact.id,
                status: 'QUEUED',
              },
              update: { status: 'QUEUED', error: null },
            });

      if (!usesInProcessSend()) {
        await pgmqSend<EmailJobData>('email-send', {
          campaignId,
          recipientId: recipient.id,
          contactId: contact.id,
          to: contact.email,
          providerId: campaign.providerId,
          organizationId: campaign.organizationId,
        });
      }
    }
  }
}

export async function processEmailJob(data: EmailJobData) {
  const { campaignId, recipientId, contactId, to, providerId } = data;
  const attempt = Number(data.attempt || 0);

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, organizationId: true, totalRecipients: true, queueSettings: true },
  });
  if (!campaign || ['PAUSED', 'CANCELLED'].includes(campaign.status)) {
    return;
  }

  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: recipientId },
    select: { status: true },
  });
  // Skip already-finished rows (duplicate queue messages after pause/resume/retry).
  if (!recipient || recipient.status !== 'QUEUED') {
    await maybeFinalizeCampaignSend(campaignId);
    return;
  }

  const qs = withRecommendedPacing(campaign.queueSettings);
  const betweenEmailMs = Math.max(0, Number(qs.betweenEmailMs ?? DEFAULT_BETWEEN_EMAIL_MS));
  const batchPauseMs = Math.max(0, Number(qs.batchPauseMs ?? DEFAULT_BATCH_PAUSE_MS));
  const batchSize = normalizeBatchSize(qs.batchSize);
  const maxPerMinute = normalizeMaxPerMinute(qs.maxPerMinute);
  const exactMs = (baseMs: number) => Math.max(0, Math.round(baseMs));

  const processedCount =
    betweenEmailMs > 0 || batchPauseMs > 0
      ? await prisma.campaignRecipient.count({
          where: { campaignId, status: { not: 'QUEUED' } },
        })
      : 0;

  async function stillSending(): Promise<boolean> {
    const live = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    return Boolean(live && live.status === 'SENDING');
  }

  async function waitMs(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!(await stillSending())) return false;
      await sleep(Math.min(1000, end - Date.now()));
    }
    return stillSending();
  }

  async function pushQueueStage(meta: Record<string, unknown>) {
    try {
      const { upsertJobProgress } = await import('../../modules/jobs/progress.js');
      const job = await prisma.job.findFirst({
        where: {
          campaignId,
          type: 'CAMPAIGN_SEND',
          status: { in: ['RUNNING', 'PENDING', 'PAUSED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, organizationId: true, total: true, processed: true, meta: true },
      });
      if (!job) return;
      const prev = (job.meta && typeof job.meta === 'object' ? job.meta : {}) as Record<string, unknown>;
      await upsertJobProgress({
        id: job.id,
        type: 'CAMPAIGN_SEND',
        organizationId: job.organizationId,
        campaignId,
        total: job.total,
        processed: job.processed,
        status: 'RUNNING',
        meta: { ...prev, ...meta } as Prisma.InputJsonValue,
      });
    } catch {
      /* UI hint must not block send */
    }
  }

  if (betweenEmailMs > 0 || batchPauseMs > 0) {
    const atBatchBoundary = processedCount > 0 && processedCount % batchSize === 0;

    if (betweenEmailMs > 0 && processedCount > 0 && !atBatchBoundary) {
      await pushQueueStage({ stage: 'between_emails', betweenEmailMs, batchSize, pauseUntil: null });
      if (!(await waitMs(exactMs(betweenEmailMs)))) return;
    }
    if (batchPauseMs > 0 && atBatchBoundary) {
      const pauseMs = exactMs(batchPauseMs);
      const batchNumber = Math.floor(processedCount / batchSize);
      await pushQueueStage({
        stage: 'batch_pause',
        pauseUntil: new Date(Date.now() + pauseMs).toISOString(),
        batchPauseMs: pauseMs,
        batchNumber,
        batchSize,
        betweenEmailMs,
      });
      if (!(await waitMs(pauseMs))) return;
      await pushQueueStage({ stage: 'sending', pauseUntil: null, betweenEmailMs, batchSize });
    }
  }

  if (!(await stillSending())) return;

  const minuteAgo = new Date(Date.now() - 60_000);
  let sentLastMinute = await prisma.campaignRecipient.count({
    where: { ...deliveredRecipientFilter(campaignId), sentAt: { gte: minuteAgo } },
  });
  while (sentLastMinute >= maxPerMinute) {
    await pushQueueStage({
      stage: 'rate_limit_pause',
      maxPerMinute,
      sentLastMinute,
      pauseUntil: new Date(Date.now() + 5_000).toISOString(),
    });
    if (!(await waitMs(5_000))) return;
    const windowStart = new Date(Date.now() - 60_000);
    sentLastMinute = await prisma.campaignRecipient.count({
      where: { ...deliveredRecipientFilter(campaignId), sentAt: { gte: windowStart } },
    });
  }

  const result = await sendCampaignEmailToRecipient({
    campaignId,
    recipientId,
    contactId,
    to,
    providerId,
  });

  if (result.paused) {
    await pushQueueStage({
      stage: 'paused',
      pauseUntil: null,
      lastError: result.error || 'Send paused before SMTP',
      lastResult: 'paused',
      lastEmail: to,
    });
    return;
  }

  if (result.retry) {
    await pushQueueStage({
      stage: 'sending',
      pauseUntil: null,
      lastError: result.error || 'Signing will retry',
      lastResult: 'retry',
      lastEmail: to,
    });
    await waitMs(3_000);
    return;
  }

  const smtpLine = `${result.smtpResponse || ''} ${result.error || ''}`.trim();
  if (result.success || result.throttled || !isSmtpAccountBlockError(smtpLine)) {
    smtpBlockStreak.set(campaignId, 0);
  } else {
    const streak = (smtpBlockStreak.get(campaignId) || 0) + 1;
    smtpBlockStreak.set(campaignId, streak);
    // One SMTP: pause on first auth/block. Several SMTPs: already failed over this
    // recipient; pause after 10 emails where every profile still blocked.
    const smtpCount = Number(result.providersAvailable ?? 1);
    const pauseAfter = smtpCount <= 1 ? 1 : SMTP_BLOCK_STREAK_LIMIT;
    if (streak >= pauseAfter) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'PAUSED' },
      });
      await drainCampaignJobs(campaignId);
      smtpBlockStreak.set(campaignId, 0);
      await writeSystemLog({
        organizationId: campaign.organizationId,
        level: 'ERROR',
        category: 'smtp',
        message: `Campaign paused after ${streak} SMTP block/auth error(s) (${smtpCount} SMTP in pool). ${smtpLine.slice(0, 180)}. Remaining recipients were left queued.`,
        meta: { campaignId, streak },
      });
      await pushQueueStage({
        stage: 'smtp_blocked',
        smtpBlockStreak: streak,
        lastError: result.error || smtpLine,
        lastResult: 'smtp_block',
        lastEmail: to,
      });
      return;
    }
  }

  const [sentCount, failedCount, pendingCount] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
  ]);

  // Keep Job row + SSE subscribers in sync so the web UI can show live progress.
  try {
    const { upsertJobProgress } = await import('../../modules/jobs/progress.js');
    const job = await prisma.job.findFirst({
      where: {
        campaignId,
        type: 'CAMPAIGN_SEND',
        status: { in: ['RUNNING', 'PENDING', 'PAUSED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, organizationId: true, total: true, meta: true },
    });
    if (job) {
      const processed = sentCount + failedCount;
      const total = Math.max(job.total || 0, campaign.totalRecipients || 0, processed);
      const done = pendingCount === 0 && processed >= total && total > 0;
      const prev = (job.meta && typeof job.meta === 'object' ? job.meta : {}) as Record<string, unknown>;
      await upsertJobProgress({
        id: job.id,
        type: 'CAMPAIGN_SEND',
        organizationId: job.organizationId,
        campaignId,
        status: done ? 'COMPLETED' : result.success ? 'RUNNING' : 'RUNNING',
        total,
        processed,
        finishedAt: done ? new Date() : null,
        meta: {
          ...prev,
          stage: done ? 'finalized' : 'sending',
          pauseUntil: null,
          betweenEmailMs,
          batchSize,
          sent: sentCount,
          failed: failedCount,
          pending: pendingCount,
          lastEmail: to,
          lastResult: result.success ? 'sent' : 'failed',
          lastError: result.success ? null : result.error || 'Send failed',
        } as Prisma.InputJsonValue,
      });
    }
  } catch {
    /* progress updates must not fail the send */
  }

  if (result.throttled) {
    const nextAttempt = attempt + 1;
    if (!throttleAttemptsLeft(nextAttempt)) {
      await prisma.$transaction([
        prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'FAILED',
            error: `Rate limited by recipient mail server after ${nextAttempt} slow-downs. ${result.error || ''}`.slice(
              0,
              500,
            ),
          },
        }),
        prisma.campaign.update({
          where: { id: campaignId },
          data: { failedCount: { increment: 1 } },
        }),
      ]);
      await maybeFinalizeCampaignSend(campaignId);
      return;
    }
    const retryAfterMs = throttleRetryMs(result.error, nextAttempt);
    const delaySeconds = Math.max(30, Math.ceil(retryAfterMs / 1000));
    await pushQueueStage({
      stage: 'throttle_pause',
      pauseUntil: new Date(Date.now() + retryAfterMs).toISOString(),
      lastError: result.error,
      lastEmail: to,
      lastResult: 'throttled',
    });
    if (!(await waitMs(Math.min(30_000, retryAfterMs)))) return;
    await pgmqSend<EmailJobData>(
      'email-send',
      {
        campaignId,
        recipientId,
        contactId,
        to,
        providerId,
        attempt: nextAttempt,
        organizationId: campaign.organizationId,
      },
      delaySeconds,
    );
    return;
  }

  // Permanent recipient failure is already stored — don't throw or the queue retries a dead row.
  // Still finalize if this was the last queued address (failed last email used to leave SENDING stuck).
  if (!result.success) {
    await maybeFinalizeCampaignSend(campaignId);
    return;
  }

  await maybeFinalizeCampaignSend(campaignId);
}

async function processBounce(data: BounceJobData) {
  const email = data.email.toLowerCase().trim();
  const contact =
    (data.contactId
      ? await prisma.contact.findFirst({
          where: { id: data.contactId, organizationId: data.organizationId },
        })
      : null) ||
    (await prisma.contact.findFirst({
      where: { organizationId: data.organizationId, email },
    }));

  if (data.type === 'HARD') {
    if (contact) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { status: 'BOUNCED', bouncedAt: new Date(), bounceType: 'HARD' },
      });
    }
    await prisma.suppressionList.upsert({
      where: {
        organizationId_email: {
          organizationId: data.organizationId,
          email,
        },
      },
      create: {
        organizationId: data.organizationId,
        email,
        reason: data.reason || 'hard_bounce',
        source: 'bounce_processor',
      },
      update: { reason: data.reason || 'hard_bounce' },
    });
  } else if (contact) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { bounceType: 'SOFT', bouncedAt: new Date() },
    });
  }

  // Flip the campaign recipient off SENT so Queue/UI show real ESP rejections.
  const recipient =
    (data.recipientId
      ? await prisma.campaignRecipient.findFirst({
          where: { id: data.recipientId },
          include: { campaign: { select: { organizationId: true } } },
        })
      : null) ||
    (data.campaignId && contact
      ? await prisma.campaignRecipient.findFirst({
          where: { campaignId: data.campaignId, contactId: contact.id },
          include: { campaign: { select: { organizationId: true } } },
        })
      : null) ||
    (contact
      ? await prisma.campaignRecipient.findFirst({
          where: {
            contactId: contact.id,
            status: { in: ['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'QUEUED'] },
            campaign: { organizationId: data.organizationId },
          },
          orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
          include: { campaign: { select: { organizationId: true } } },
        })
      : null);

  if (!recipient || recipient.campaign.organizationId !== data.organizationId) {
    if (data.campaignId && data.type === 'HARD') {
      await prisma.campaign.update({
        where: { id: data.campaignId },
        data: { bouncedCount: { increment: 1 } },
      });
    }
    return;
  }

  const reason =
    data.reason ||
    (data.type === 'HARD' ? 'Hard bounce / rejected by provider' : 'Soft bounce / deferred');
  const alreadyTerminal = recipient.status === 'BOUNCED' || recipient.status === 'FAILED';

  await prisma.trackingEvent.create({
    data: {
      type: 'BOUNCED',
      campaignId: recipient.campaignId,
      contactId: contact?.id ?? null,
      messageId: data.messageId || recipient.messageId,
      metadata: { bounceType: data.type, reason },
    },
  });

  if (data.type === 'HARD' && !alreadyTerminal) {
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: 'BOUNCED',
        bouncedAt: new Date(),
        error: reason.slice(0, 500),
      },
    });
    await prisma.campaign.update({
      where: { id: data.campaignId || recipient.campaignId },
      data: { bouncedCount: { increment: 1 } },
    });
  } else if (data.type === 'SOFT' && !alreadyTerminal && !recipient.error) {
    // Soft/deferred: keep SENT so a later delivered webhook can still win; surface reason in UI.
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: { error: `Soft bounce: ${reason}`.slice(0, 500) },
    });
  }
}

type SegmentRules = {
  conditions?: Array<{ field: string; operator: string; value: string }>;
  match?: 'all' | 'any';
};

async function resolveSegmentContacts(organizationId: string, rules: SegmentRules) {
  const contacts = await prisma.contact.findMany({
    where: { organizationId, status: 'SUBSCRIBED' },
  });

  if (!rules.conditions?.length) return contacts;

  return contacts.filter((c) => {
    const checks = rules.conditions!.map((cond) => {
      const val = String(
        cond.field === 'email'
          ? c.email
          : cond.field === 'firstName'
            ? c.firstName
            : cond.field === 'lastName'
              ? c.lastName
              : ((c.customData as Record<string, string>)?.[cond.field] ?? ''),
      ).toLowerCase();
      const target = cond.value.toLowerCase();
      switch (cond.operator) {
        case 'equals':
          return val === target;
        case 'contains':
          return val.includes(target);
        case 'starts_with':
          return val.startsWith(target);
        default:
          return false;
      }
    });
    return rules.match === 'any' ? checks.some(Boolean) : checks.every(Boolean);
  });
}

export { resolveSegmentContacts };
export type { SegmentRules };
