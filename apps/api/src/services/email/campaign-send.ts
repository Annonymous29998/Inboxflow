import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { decrypt } from '../../utils/crypto.js';
import { parseProviderConfig, sendViaProvider } from './providers.js';
import { resolveSmtpFromEmail } from './mail-headers.js';
import {
  incrementHourlySent,
  incrementMinuteSent,
  logRotationPick,
  parseRotationSettings,
  resolveRotatedProviders,
} from './smtp-rotation.js';
import { writeSystemLog } from '../system-log.js';
import { signClickRedirect, signUnsubscribe } from '../../utils/signed-urls.js';
import { hardenOutboundMime } from '../../modules/deliverability/spam-scrubber.js';
import { applySenderName, personalize } from './personalize.js';

function pickFromPool(pool: unknown, fallback: string): string {
  const arr = Array.isArray(pool)
    ? pool.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!arr.length) return fallback;
  return arr[Math.floor(Math.random() * arr.length)]!;
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

  const subjectBase = pickFromPool(campaign.subjectPool, campaign.subject || '');
  const fromNameBase = pickFromPool(campaign.fromNamePool, campaign.senderName || '');
  // Contact merge tags only — {{sender_name}} is applied per attempt once From name is final.
  let html = personalize(campaign.htmlContent || '', contact);
  let text = personalize(campaign.plainTextContent || '', contact);
  let subject = personalize(subjectBase, contact);

  // Auto-harden every outbound message (including templates already stored in DB).
  const hardened = hardenOutboundMime({
    subject,
    previewText: campaign.previewText,
    html,
    text,
  });
  subject = hardened.subject;
  html = hardened.html;
  text = hardened.text;

  const unsubSig = signUnsubscribe(contactId, campaignId);
  const unsubscribeUrl = `${env.API_URL}/api/t/unsubscribe?c=${encodeURIComponent(contactId)}&cid=${encodeURIComponent(campaignId)}&s=${encodeURIComponent(unsubSig)}`;
  html = html.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl);
  text = text.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl);

  const hasUnsub =
    /unsubscribe|opt[\s-]?out|list-unsubscribe/i.test(`${html}\n${text}`);
  const physical = String(campaign.organization.physicalAddress || '').trim();
  if (!hasUnsub || physical) {
    const footerBits: string[] = [];
    if (!hasUnsub) {
      footerBits.push(
        `<p style="font-size:12px;color:#666;margin-top:24px"><a href="${unsubscribeUrl}">Unsubscribe from these emails</a></p>`,
      );
    }
    if (physical && !html.toLowerCase().includes(physical.toLowerCase().slice(0, 24))) {
      footerBits.push(`<p style="font-size:12px;color:#666">${physical.replace(/</g, '&lt;')}</p>`);
    }
    if (footerBits.length) {
      const footer = `<div data-inboxflow-footer>${footerBits.join('')}</div>`;
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${footer}</body>`);
      else html += footer;
    }
    if (!hasUnsub) {
      text = `${text}\n\nUnsubscribe: ${unsubscribeUrl}`.trim();
    }
    if (physical && !text.toLowerCase().includes(physical.toLowerCase().slice(0, 24))) {
      text = `${text}\n${physical}`.trim();
    }
  }

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
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  if (hardened.previewText) {
    headers['X-Preview-Text'] = hardened.previewText.slice(0, 150);
  }
  const replyTo = campaign.replyTo || undefined;
  if (replyTo) headers['Reply-To'] = replyTo;

  let dkim:
    | {
        domainName: string;
        keySelector: string;
        privateKey: string;
      }
    | undefined;
  if (campaign.domain?.dkimPrivateKeyEnc && campaign.domain.dkimSelector) {
    try {
      dkim = {
        domainName: campaign.domain.domain,
        keySelector: campaign.domain.dkimSelector,
        privateKey: decrypt(campaign.domain.dkimPrivateKeyEnc),
      };
    } catch {
      /* invalid key — skip signing */
    }
  }

  let lastError = 'Unknown error';
  for (const p of providers) {
    const cfg = parseProviderConfig(p.config);
    const fromName = String(fromNameBase || cfg.fromName || campaign.senderName || '').trim();
    const resolvedFrom = resolveSmtpFromEmail(campaign.senderEmail || undefined, cfg);
    const fromEmail = resolvedFrom.from;
    if (!fromEmail) {
      lastError = 'Sender email is required on the SMTP profile';
      continue;
    }

    const htmlOut = applySenderName(html, fromName);
    const textOut = applySenderName(text, fromName);
    const subjectOut = applySenderName(subject, fromName);

    const result = await sendViaProvider(
      p.type,
      p.config,
      {
        to,
        from: fromEmail,
        fromName,
        replyTo: campaign.replyTo || cfg.replyTo || undefined,
        subject: subjectOut,
        html: htmlOut,
        text: textOut || undefined,
        headers,
        dkim,
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
            deliveredAt: new Date(),
            error: null,
          },
        }),
        prisma.campaign.update({
          where: { id: campaignId },
          data: { sentCount: { increment: 1 }, deliveredCount: { increment: 1 } },
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
          data: { sentToday: { increment: 1 }, successCount: { increment: 1 } },
        }),
      ]);
      await incrementHourlySent(p.id);
      await incrementMinuteSent(p.id);
      return { success: true, messageId: result.messageId, providerId: p.id };
    }

    lastError = result.error || lastError;
    await prisma.emailProvider.update({
      where: { id: p.id },
      data: { failCount: { increment: 1 } },
    });
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

export { personalize, firstNameFromEmail } from './personalize.js';
