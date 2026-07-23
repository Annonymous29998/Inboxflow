import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { parseProviderConfig, sendViaProvider } from './providers.js';
import {
  incrementHourlySent,
  logRotationPick,
  parseRotationSettings,
  resolveRotatedProviders,
} from './smtp-rotation.js';
import { writeSystemLog } from '../system-log.js';
import { signClickRedirect } from '../../utils/signed-urls.js';

function personalize(
  template: string,
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    customData?: unknown;
  },
) {
  const custom = (contact.customData || {}) as Record<string, string>;
  return template
    .replace(/\{\{\s*firstName\s*\}\}/gi, contact.firstName || '')
    .replace(/\{\{\s*lastName\s*\}\}/gi, contact.lastName || '')
    .replace(/\{\{\s*email\s*\}\}/gi, contact.email)
    .replace(
      /\{\{\s*name\s*\}\}/gi,
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email,
    )
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => custom[key] ?? '');
}

/** @deprecated Prefer resolveRotatedProviders — kept for callers that need a simple list. */
export async function resolveCampaignProviders(organizationId: string, preferredProviderId?: string | null) {
  return resolveRotatedProviders({
    organizationId,
    preferredProviderId,
    rotation: { enabled: false, mode: 'failover' },
  });
}

export async function sendCampaignEmailToRecipient(input: {
  campaignId: string;
  recipientId: string;
  contactId: string;
  to: string;
  providerId?: string | null;
}) {
  const { campaignId, recipientId, contactId, to } = input;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { organization: true, domain: true },
  });
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });

  if (!campaign || !contact) throw new Error('Missing campaign or contact');

  if (['PAUSED', 'CANCELLED'].includes(campaign.status)) {
    throw new Error(`Campaign is ${campaign.status.toLowerCase()}`);
  }

  if (contact.status !== 'SUBSCRIBED') {
    await prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: { status: 'FAILED', error: 'Contact not subscribed' },
    });
    return { success: false, error: 'Contact not subscribed' };
  }

  const rotation = parseRotationSettings(campaign.organization.sendSettings);
  // Campaign providerId = null / '' / 'rotate' → full rotation pool
  const rawPreferred = input.providerId ?? campaign.providerId;
  const preferredId =
    !rawPreferred || rawPreferred === 'rotate' || rawPreferred === 'auto' ? null : rawPreferred;

  const providers = await resolveRotatedProviders({
    organizationId: campaign.organizationId,
    preferredProviderId: preferredId,
    rotation,
  });

  if (!providers.length) throw new Error('No active email provider configured (or all hit sending limits)');

  if (rotation.enabled && providers[0]) {
    await logRotationPick(campaign.organizationId, providers[0], rotation.mode);
  }

  let html = personalize(campaign.htmlContent || '', contact);
  let text = personalize(campaign.plainTextContent || '', contact);
  html = html.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '');
  text = text.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '');

  if (campaign.trackOpens) {
    const pixel = `<img src="${env.API_URL}/api/t/o/${campaignId}/${contactId}.gif" width="1" height="1" alt="" style="display:none" />`;
    html = html.replace(/<\/body>/i, `${pixel}</body>`);
    if (!html.includes(pixel)) html += pixel;
  }

  if (campaign.trackClicks) {
    html = html.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (_m, url: string) => {
      const sig = signClickRedirect(campaignId, contactId, url);
      const tracked = `${env.API_URL}/api/t/c/${campaignId}/${contactId}?u=${encodeURIComponent(url)}&s=${sig}`;
      return `href="${tracked}"`;
    });
  }

  const headers: Record<string, string> = {
    'X-Mailer': 'Inbox Flow',
  };
  const replyTo = campaign.replyTo || undefined;
  if (replyTo) headers['Reply-To'] = replyTo;

  let lastError = 'Unknown error';
  for (const p of providers) {
    const cfg = parseProviderConfig(p.config);
    const fromEmail =
      campaign.senderEmail ||
      cfg.fromEmail ||
      cfg.user ||
      `noreply@${campaign.domain?.domain || 'localhost'}`;
    const fromName = campaign.senderName || cfg.fromName || campaign.organization.name;

    const result = await sendViaProvider(
      p.type,
      p.config,
      {
        to,
        from: fromEmail,
        fromName,
        replyTo: campaign.replyTo || cfg.replyTo || undefined,
        subject: personalize(campaign.subject || '', contact),
        html,
        text: text || undefined,
        headers,
      },
      { portFailover: p.isDefault && p.type === 'SMTP' },
    );

    if (result.success) {
      await prisma.$transaction([
        prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'SENT',
            messageId: result.messageId,
            sentAt: new Date(),
            error: null,
          },
        }),
        prisma.campaign.update({
          where: { id: campaignId },
          data: { sentCount: { increment: 1 } },
        }),
        prisma.trackingEvent.create({
          data: {
            type: 'SENT',
            campaignId,
            contactId,
            messageId: result.messageId,
          },
        }),
        prisma.emailProvider.update({
          where: { id: p.id },
          data: { sentToday: { increment: 1 } },
        }),
      ]);
      await incrementHourlySent(p.id);
      return { success: true, messageId: result.messageId, providerId: p.id };
    }

    lastError = result.error || lastError;
    await writeSystemLog({
      organizationId: campaign.organizationId,
      level: 'WARNING',
      category: 'smtp',
      message: `SMTP failover after failure on ${p.name}: ${lastError}`,
      meta: { providerId: p.id },
    });
  }

  await prisma.campaignRecipient.update({
    where: { id: recipientId },
    data: { status: 'FAILED', error: lastError },
  });

  return { success: false, error: lastError };
}

export { personalize };
