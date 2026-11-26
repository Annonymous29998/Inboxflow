import { prisma } from '../../config/prisma.js';
import { dispatchCampaign, processEmailJob } from './queue.js';
import { maybeFinalizeCampaignSend } from './campaign-finalize.js';
import { mergeOperatorPulse } from '../admin/operator-pulse.js';
import { writeSystemLog } from '../system-log.js';
import { cloudAuthorizationFor } from './desktop-cloud-auth.js';
import { orgKeepsWorkspaceOnDevice } from './workspace-residency.js';

const running = new Map<string, Promise<void>>();
let supervisorStarted = false;
let lastPulseAt = 0;

async function stampDesktopPulse(organizationId: string) {
  const now = Date.now();
  if (now - lastPulseAt < 20_000) return;
  lastPulseAt = now;
  try {
    const [sending, sent, emails, org] = await Promise.all([
      prisma.campaign.count({ where: { organizationId, status: 'SENDING' } }),
      prisma.campaign.count({ where: { organizationId, status: 'SENT' } }),
      prisma.campaign.aggregate({
        where: { organizationId },
        _sum: { sentCount: true, failedCount: true },
      }),
      prisma.organization.findUnique({
        where: { id: organizationId },
        select: { sendSettings: true },
      }),
    ]);
    const recent = await prisma.campaign.findMany({
      where: { organizationId, status: { in: ['SENDING', 'SENT', 'PAUSED', 'FAILED'] } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { id: true, name: true, status: true, sentCount: true, openedCount: true, updatedAt: true },
    });
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        sendSettings: mergeOperatorPulse(org?.sendSettings, {
          lastSeenAt: new Date().toISOString(),
          sending,
          campaignsSent: sent,
          emailsSent: emails._sum.sentCount ?? 0,
          emailsFailed: emails._sum.failedCount ?? 0,
          recentCampaigns: recent.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            sentCount: c.sentCount,
            openedCount: c.openedCount,
            updatedAt: c.updatedAt.toISOString(),
          })),
        }) as object,
      },
    });
  } catch (err) {
    console.warn('[local-send] pulse skipped', err instanceof Error ? err.message : err);
  }
}

const LOCAL_SEND_CONCURRENCY = 4;
const claimedRecipients = new Set<string>();
let claimChain: Promise<unknown> = Promise.resolve();

async function claimNextQueued(campaignId: string) {
  const run = claimChain.then(async () => {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true, providerId: true, organizationId: true },
    });
    if (!campaign || campaign.status !== 'SENDING') return null;
    const row = await prisma.campaignRecipient.findFirst({
      where: {
        campaignId,
        status: 'QUEUED',
        ...(claimedRecipients.size ? { id: { notIn: [...claimedRecipients] } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        contactId: true,
        contact: { select: { email: true } },
      },
    });
    if (!row?.contact?.email) return null;
    claimedRecipients.add(row.id);
    return { campaign, row };
  });
  claimChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function drainQueuedLocally(campaignId: string) {
  async function worker() {
    for (;;) {
      const next = await claimNextQueued(campaignId);
      if (!next) return;
      try {
        await processEmailJob({
          campaignId,
          recipientId: next.row.id,
          contactId: next.row.contactId,
          to: next.row.contact.email,
          providerId: next.campaign.providerId,
          organizationId: next.campaign.organizationId,
        });
        await stampDesktopPulse(next.campaign.organizationId);
      } finally {
        claimedRecipients.delete(next.row.id);
      }
    }
  }

  await Promise.all(Array.from({ length: LOCAL_SEND_CONCURRENCY }, () => worker()));
  await maybeFinalizeCampaignSend(campaignId);
}

async function runLocalCampaign(campaignId: string) {
  try {
    const row = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { organizationId: true, totalRecipients: true, createdById: true },
    });
    if (row?.organizationId) {
      const org = await prisma.organization.findUnique({
        where: { id: row.organizationId },
        select: { sendSettings: true },
      });
      if (
        org &&
        orgKeepsWorkspaceOnDevice({ sendSettings: org.sendSettings }) &&
        !cloudAuthorizationFor(row.organizationId)
      ) {
        return;
      }
      const { ensureCampaignSendJob } = await import('../../modules/jobs/progress.js');
      await ensureCampaignSendJob({
        campaignId,
        organizationId: row.organizationId,
        createdById: row.createdById,
        total: row.totalRecipients || 0,
      });
    }
    await dispatchCampaign(campaignId);
    await drainQueuedLocally(campaignId);
  } catch (err) {
    console.error('[local-send]', campaignId, err);
    const row = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { organizationId: true },
    });
    if (row?.organizationId) {
      await writeSystemLog({
        organizationId: row.organizationId,
        level: 'ERROR',
        category: 'queue',
        message: `Local send stopped: ${err instanceof Error ? err.message : String(err)}`,
      }).catch(() => undefined);
    }
  }
}

/** Node process on the RDP/desktop box — not the browser tab. */
export function startLocalCampaignSend(campaignId: string) {
  if (running.has(campaignId)) return;
  const job = runLocalCampaign(campaignId).finally(() => {
    running.delete(campaignId);
  });
  running.set(campaignId, job);
}

export function startLocalSendSupervisor() {
  if (supervisorStarted) return;
  supervisorStarted = true;
  const tick = async () => {
    try {
      const rows = await prisma.campaign.findMany({
        where: { status: 'SENDING' },
        select: { id: true },
      });
      for (const row of rows) startLocalCampaignSend(row.id);
    } catch (err) {
      console.warn('[local-send] supervisor', err instanceof Error ? err.message : err);
    }
  };
  void tick();
  setInterval(() => void tick(), 8_000);
}
