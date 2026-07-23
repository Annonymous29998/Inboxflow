import {
  ensurePgmqQueues,
  pgmqArchive,
  pgmqArchiveByCampaign,
  pgmqDelete,
  pgmqRead,
  pgmqSend,
  sleep,
  type QueueName,
} from '../queue/pgmq-client.js';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { analyzeCampaign } from '../../modules/deliverability/analyzer.js';
import { sendCampaignEmailToRecipient } from './campaign-send.js';

export type EmailJobData = {
  campaignId: string;
  recipientId: string;
  contactId: string;
  to: string;
  attempt?: number;
  providerId?: string | null;
};

export type CampaignJobData = {
  campaignId: string;
};

export type BounceJobData = {
  email: string;
  type: 'HARD' | 'SOFT';
  organizationId: string;
  campaignId?: string;
};

const MAX_ATTEMPTS = env.MAX_RETRY_ATTEMPTS;
const VISIBILITY_SEC = 300;

export async function enqueueCampaign(campaignId: string) {
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
  await pgmqArchiveByCampaign('email-send', campaignId);
}

async function handleJobFailure(queue: QueueName, msgId: bigint, readCt: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Queue ${queue} job ${msgId} failed (attempt ${readCt}):`, message);
  if (readCt >= MAX_ATTEMPTS) {
    await pgmqArchive(queue, msgId);
  }
}

export function startWorkers() {
  void ensurePgmqQueues().then(() => {
    void runCampaignWorker();
    void runEmailWorker();
    void runBounceWorker();
    console.log('Workers started: campaign-dispatch, email-send, bounce-process (Supabase Queues / pgmq)');
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
  const minGapMs = Math.max(50, Math.floor(1000 / Math.max(1, env.DEFAULT_SEND_RATE)));

  for (;;) {
    try {
      const batch = await pgmqRead<EmailJobData>('email-send', VISIBILITY_SEC, 1);
      if (!batch.length) {
        await sleep(500);
        continue;
      }

      const row = batch[0]!;
      try {
        await processEmailJob(row.message);
        await pgmqDelete('email-send', row.msg_id);
      } catch (err) {
        await handleJobFailure('email-send', row.msg_id, row.read_ct, err);
      }

      await sleep(minGapMs);
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

async function dispatchCampaign(campaignId: string) {
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
  contacts = contacts.filter((c) => !suppressedSet.has(c.email.toLowerCase()));

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalRecipients: contacts.length },
  });

  const queueSettings = (campaign.queueSettings || {}) as {
    batchSize?: number;
    batchPauseMs?: number;
    betweenEmailMs?: number;
  };
  const batchSize = Math.max(1, Number(queueSettings.batchSize || env.BATCH_SIZE || 10));
  const batchPauseMs = Math.max(0, Number(queueSettings.batchPauseMs ?? 0));
  const betweenEmailMs = Math.max(0, Number(queueSettings.betweenEmailMs ?? 0));

  for (let i = 0; i < contacts.length; i += batchSize) {
    const live = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!live || ['PAUSED', 'CANCELLED'].includes(live.status)) {
      return;
    }

    if (i > 0 && batchPauseMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchPauseMs));
    }

    const batch = contacts.slice(i, i + batchSize);
    const recipients = await Promise.all(
      batch.map((contact) =>
        prisma.campaignRecipient.upsert({
          where: {
            campaignId_contactId: { campaignId, contactId: contact.id },
          },
          create: {
            campaignId,
            contactId: contact.id,
            status: 'QUEUED',
          },
          update: { status: 'QUEUED', error: null },
        }),
      ),
    );

    for (let idx = 0; idx < recipients.length; idx += 1) {
      const r = recipients[idx]!;
      const contact = batch[idx]!;
      if (idx > 0 && betweenEmailMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, betweenEmailMs));
      }
      await pgmqSend<EmailJobData>('email-send', {
        campaignId,
        recipientId: r.id,
        contactId: contact.id,
        to: contact.email,
        providerId: campaign.providerId,
      });
    }
  }
}

async function processEmailJob(data: EmailJobData) {
  const { campaignId, recipientId, contactId, to, providerId } = data;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign || ['PAUSED', 'CANCELLED'].includes(campaign.status)) {
    return;
  }

  const result = await sendCampaignEmailToRecipient({
    campaignId,
    recipientId,
    contactId,
    to,
    providerId,
  });

  if (!result.success) {
    throw new Error(result.error || 'Send failed');
  }

  const counts = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { sentCount: true, totalRecipients: true, status: true },
  });
  if (
    counts &&
    counts.status === 'SENDING' &&
    counts.totalRecipients > 0 &&
    counts.sentCount >= counts.totalRecipients
  ) {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'SENT', completedAt: new Date() },
    });
  }
}

async function processBounce(data: BounceJobData) {
  const contact = await prisma.contact.findFirst({
    where: { organizationId: data.organizationId, email: data.email.toLowerCase() },
  });

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
          email: data.email.toLowerCase(),
        },
      },
      create: {
        organizationId: data.organizationId,
        email: data.email.toLowerCase(),
        reason: 'hard_bounce',
        source: 'bounce_processor',
      },
      update: { reason: 'hard_bounce' },
    });
  } else if (contact) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { bounceType: 'SOFT', bouncedAt: new Date() },
    });
  }

  if (data.campaignId) {
    await prisma.campaign.update({
      where: { id: data.campaignId },
      data: { bouncedCount: { increment: 1 } },
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
