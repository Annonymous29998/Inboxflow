import { prisma } from '../../config/prisma.js';
import { deliveredRecipientFilter } from './recipient-stats.js';
import { isCountableClick, isCountableOpen } from '../../utils/tracking-bot-filter.js';
import { countHumanClicks, countHumanOpens } from '../../services/tracking/recount.js';

export type SendActivityRow = {
  email: string;
  status: 'SENT' | 'FAILED' | 'OPENED' | 'CLICKED';
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
    pendingCount,
    recentFailures,
    recentDelivered,
    openEvents,
    clickEvents,
    humanOpened,
    humanClicked,
  ] = await Promise.all([
    prisma.campaignRecipient.count({ where: deliveredRecipientFilter(campaignId) }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignRecipient.count({ where: { campaignId, status: 'QUEUED' } }),
    prisma.campaignRecipient.findMany({
      where: { campaignId, status: 'FAILED' },
      include: { contact: { select: { email: true } } },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
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
  ]);

  const verifiedOpenIds = new Set(
    openEvents
      .filter((e) => isCountableOpen(e.userAgent, e.metadata))
      .map((e) => e.contactId)
      .filter(Boolean) as string[],
  );

  const countableClicks = clickEvents.filter(
    (e) =>
      e.contactId &&
      verifiedOpenIds.has(e.contactId) &&
      isCountableClick(e.userAgent, e.metadata, true),
  );

  const activity: SendActivityRow[] = [
    ...recentDelivered.map((r) => ({
      email: r.contact.email,
      status: 'SENT' as const,
      error: null,
      at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
    })),
    ...recentFailures.map((r) => ({
      email: r.contact.email,
      status: 'FAILED' as const,
      error: r.error || 'Send failed',
      at: r.sentAt?.toISOString() || r.createdAt.toISOString(),
    })),
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
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 100);

  const recentSent = recentDelivered.slice(0, 12).map((r) => ({
    email: r.contact.email,
    at: r.sentAt,
  }));

  return {
    success: true,
    status: campaign.status,
    name: campaign.name,
    subject: campaign.subject,
    senderEmail: campaign.senderEmail,
    totalRecipients: campaign.totalRecipients,
    sentCount,
    failedCount,
    pendingCount,
    openedCount: humanOpened,
    clickedCount: humanClicked,
    completedAt: campaign.completedAt,
    lastEmail: activity[0]?.email || null,
    recentSent,
    recentFailures: recentFailures.slice(0, 40).map((r) => ({
      email: r.contact.email,
      error: r.error || 'Send failed',
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
    activity,
  };
}
