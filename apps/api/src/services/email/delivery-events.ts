import { prisma } from '../../config/prisma.js';

type RecipientRow = {
  id: string;
  campaignId: string;
  contactId: string;
  status: string;
  deliveredAt: Date | null;
  messageId: string | null;
  campaign: { organizationId: string };
  contact: { email: string };
};

/** Mark a recipient as delivered after ESP confirms (e.g. Brevo delivered webhook). */
export async function markRecipientDelivered(opts: {
  organizationId: string;
  email?: string;
  campaignId?: string;
  recipientId?: string;
  contactId?: string;
  messageId?: string;
}): Promise<boolean> {
  const email = opts.email?.toLowerCase().trim();
  let recipient: RecipientRow | null = null;

  if (opts.recipientId) {
    recipient = await prisma.campaignRecipient.findFirst({
      where: { id: opts.recipientId },
      include: { campaign: { select: { organizationId: true } }, contact: { select: { email: true } } },
    });
  }

  if (!recipient && opts.messageId) {
    recipient = await prisma.campaignRecipient.findFirst({
      where: { messageId: opts.messageId, campaign: { organizationId: opts.organizationId } },
      include: { campaign: { select: { organizationId: true } }, contact: { select: { email: true } } },
    });
  }

  if (!recipient && opts.campaignId && (opts.contactId || email)) {
    const contact =
      (opts.contactId
        ? await prisma.contact.findFirst({
            where: { id: opts.contactId, organizationId: opts.organizationId },
          })
        : null) ||
      (email
        ? await prisma.contact.findFirst({
            where: { organizationId: opts.organizationId, email },
          })
        : null);
    if (contact) {
      recipient = await prisma.campaignRecipient.findFirst({
        where: { campaignId: opts.campaignId, contactId: contact.id },
        include: { campaign: { select: { organizationId: true } }, contact: { select: { email: true } } },
      });
    }
  }

  if (!recipient && email) {
    recipient = await prisma.campaignRecipient.findFirst({
      where: {
        contact: { email, organizationId: opts.organizationId },
        status: { in: ['SENT', 'QUEUED', 'BOUNCED'] },
        campaign: { organizationId: opts.organizationId },
      },
      orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
      include: { campaign: { select: { organizationId: true } }, contact: { select: { email: true } } },
    });
  }

  if (!recipient || recipient.campaign.organizationId !== opts.organizationId) return false;
  if (recipient.status === 'FAILED') return false;
  if (recipient.deliveredAt && (recipient.status === 'DELIVERED' || recipient.status === 'OPENED' || recipient.status === 'CLICKED')) {
    return true;
  }

  const wasNotCounted =
    !recipient.deliveredAt &&
    (recipient.status === 'SENT' || recipient.status === 'QUEUED' || recipient.status === 'BOUNCED');
  const nextStatus =
    recipient.status === 'OPENED' || recipient.status === 'CLICKED' ? recipient.status : 'DELIVERED';

  await prisma.$transaction([
    prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        status: nextStatus,
        deliveredAt: recipient.deliveredAt || new Date(),
        error: null,
        ...(recipient.status === 'BOUNCED' ? { bouncedAt: null } : {}),
      },
    }),
    ...(wasNotCounted
      ? [
          prisma.campaign.update({
            where: { id: recipient.campaignId },
            data: { deliveredCount: { increment: 1 } },
          }),
        ]
      : []),
    prisma.trackingEvent.create({
      data: {
        type: 'DELIVERED',
        campaignId: recipient.campaignId,
        contactId: recipient.contactId,
        messageId: opts.messageId || recipient.messageId,
      },
    }),
  ]);
  return true;
}

export function parseBrevoCustom(raw: unknown): {
  campaignId?: string;
  recipientId?: string;
  contactId?: string;
} {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    return {
      campaignId: typeof o.campaignId === 'string' ? o.campaignId : undefined,
      recipientId: typeof o.recipientId === 'string' ? o.recipientId : undefined,
      contactId: typeof o.contactId === 'string' ? o.contactId : undefined,
    };
  }
  if (typeof raw === 'string') {
    try {
      return parseBrevoCustom(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return {};
}
