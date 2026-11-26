import { prisma } from '../../config/prisma.js';
import { decrypt } from '../../utils/crypto.js';
import { parseProviderConfig, sendViaProvider, type SendEmailPayload } from './providers.js';
import { emailDomain, ensureOwnUnsubscribe, listUnsubscribeHeaders, parseSmtpFromIdentities, resolveSmtpFromEmail } from './mail-headers.js';
import {
  incrementHourlySent,
  incrementMinuteSent,
  logRotationPick,
  commitFromIdentityIndex,
  parseRotationSettings,
  peekFromIdentityIndex,
  resolveRotatedProviders,
} from './smtp-rotation.js';
import { writeSystemLog } from '../system-log.js';
import { cloudAuthorizationFor } from './desktop-cloud-auth.js';
import { signOpen, signUnsubscribe } from '../../utils/signed-urls.js';
import { hardenOutboundMime } from '../../modules/deliverability/spam-scrubber.js';
import { applySenderName, personalize } from './personalize.js';
import { applyRelayClickTickets, listTrackableLinks } from './wrap-campaign-links.js';
import { mintRelayTracking } from './tracking-relay.js';
import { cloudTrackingOrigin, isLoopbackPublicUrl, isMailboxProviderTrackingOrigin, preferVerifiedTrackingOrigin, resolveTrackingOrigin } from './public-url.js';
import { orgKeepsWorkspaceOnDevice } from './workspace-residency.js';
import {
  classifySmtpRecipientResult,
  smtpRecipientStatus,
} from './smtp-recipient-result.js';
import { isSmtpThrottleError, throttleRetryMs } from './smtp-throttle.js';
import { orgAllowsDirectSmtp } from './smtp-outbound.js';
import { guardRecipientAddress } from './recipient-guard.js';

function pickFromPool(pool: unknown, fallback: string): string {
  const arr = Array.isArray(pool)
    ? pool.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!arr.length) return fallback;
  return arr[Math.floor(Math.random() * arr.length)]!;
}

async function trackingOrigin(campaign: {
  organizationId: string;
  senderEmail?: string | null;
  organization?: { sendSettings?: unknown } | null;
  domain?: { domain?: string; trackingDomain?: string | null; trackingValid?: boolean } | null;
}) {
  const settings = campaign.organization?.sendSettings;
  const onDevice = orgKeepsWorkspaceOnDevice({ sendSettings: settings });
  const rows = await prisma.domain.findMany({
    where: { organizationId: campaign.organizationId, trackingValid: true },
    select: { trackingDomain: true, trackingValid: true },
    orderBy: { updatedAt: 'desc' },
    take: 1,
  });
  const chosen = rows[0] || httpsHost(campaign.domain);
  if (chosen?.trackingValid && chosen.trackingDomain) {
    return resolveTrackingOrigin({
      trackingDomain: chosen.trackingDomain,
      trackingValid: true,
      sendSettings: settings,
      workspaceOnDevice: onDevice,
    });
  }
  return resolveTrackingOrigin({ sendSettings: settings, workspaceOnDevice: onDevice });
}

function httpsHost(domain?: { trackingDomain?: string | null; trackingValid?: boolean } | null) {
  if (!domain?.trackingValid || !domain.trackingDomain) return null;
  return { trackingDomain: domain.trackingDomain, trackingValid: true };
}

/** Reply-To is set on the message itself. Brevo's custom header stays off raw SMTP. */
function headersForProvider(headers: Record<string, string> | undefined, providerType: string) {
  const next = { ...(headers || {}) };
  delete next['Reply-To'];
  delete next['X-Preview-Text'];
  if (providerType === 'SMTP') delete next['X-Mailin-custom'];
  return next;
}

async function maybePauseOnFailRate(campaignId: string, organizationId: string) {
  const row = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, sentCount: true, failedCount: true, bouncedCount: true, queueSettings: true },
  });
  if (!row || row.status !== 'SENDING') return;
  const qs = (row.queueSettings && typeof row.queueSettings === 'object' ? row.queueSettings : {}) as {
    maxFailPercent?: number;
    maxFailMinProcessed?: number;
  };
  const maxFailPercent = Number(qs.maxFailPercent);
  if (!Number.isFinite(maxFailPercent) || maxFailPercent <= 0) return;
  const minN = Number(qs.maxFailMinProcessed);
  const floor = Number.isFinite(minN) && minN > 0 ? minN : 20;
  const processed = row.sentCount + row.failedCount + row.bouncedCount;
  if (processed < floor) return;
  const fail = row.failedCount + row.bouncedCount;
  if ((fail / processed) * 100 < maxFailPercent) return;
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PAUSED' } });
  const { drainCampaignJobs } = await import('./queue.js');
  await drainCampaignJobs(campaignId);
  await writeSystemLog({
    organizationId,
    level: 'WARNING',
    category: 'queue',
    message: `Campaign paused — fail rate ${Math.round((fail / processed) * 100)}% (limit ${maxFailPercent}%)`,
    meta: { campaignId, fail, processed, maxFailPercent },
  });
}

function parseIdPool(pool: unknown, extraId?: string | null): string[] {
  const ids = Array.isArray(pool)
    ? pool.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const extra = String(extraId || '').trim();
  if (extra && !ids.includes(extra)) ids.unshift(extra);
  return [...new Set(ids)];
}

/** @deprecated Prefer resolveRotatedProviders — kept for callers that need a simple list. */
export async function resolveCampaignProviders(organizationId: string, preferredProviderId?: string | null) {
  return resolveRotatedProviders({
    organizationId,
    preferredProviderId,
    rotation: { enabled: false, mode: 'failover' },
  });
}

export type LiveSendResult = {
  success: boolean;
  messageId?: string;
  smtpResponse?: string;
  error?: string;
  throttled?: boolean;
  retryAfterMs?: number;
  providerId?: string;
  providerName?: string;
  providerHost?: string | null;
  fromEmail?: string;
  /** Active SMTP/API profiles considered for this send (failover pool size). */
  providersAvailable?: number;
};

type LiveCampaign = {
  senderEmail?: string | null;
  senderName?: string | null;
  replyTo?: string | null;
  providerId?: string | null;
  organizationId: string;
  domain?: {
    domain: string;
    dkimSelector: string | null;
    dkimPrivateKeyEnc: string | null;
  } | null;
  organization: { sendSettings: unknown };
};

/** Real SMTP/API DATA — same path for campaign recipients and placement tests. */
export async function deliverLiveMessage(input: {
  campaign: LiveCampaign;
  to: string;
  html: string;
  text: string;
  subject: string;
  fromName: string;
  headers: Record<string, string>;
  sendChannel: 'smtp' | 'api' | null;
  preferredProviderId?: string | null;
  rotationEnabled?: boolean;
  countUsage?: boolean;
  /** Recipient index so From addresses on one SMTP round-robin instead of sticking to the first. */
  fromRotateIndex?: number;
  attachments?: SendEmailPayload['attachments'];
}): Promise<LiveSendResult> {
  const campaign = input.campaign;
  const rotation = parseRotationSettings(campaign.organization.sendSettings);
  const useRotation = input.rotationEnabled ?? rotation.enabled;
  const rawPreferred = input.preferredProviderId ?? campaign.providerId;
  const preferredId =
    !rawPreferred || rawPreferred === 'rotate' || rawPreferred === 'auto' ? null : rawPreferred;

  const providers = await resolveRotatedProviders({
    organizationId: campaign.organizationId,
    preferredProviderId: preferredId,
    rotation: { ...rotation, enabled: useRotation },
    sendChannel: input.sendChannel,
  });
  if (!providers.length) {
    return {
      success: false,
      error: 'No active email provider configured (or all hit sending limits)',
      providersAvailable: 0,
    };
  }
  if (useRotation && providers[0]) {
    await logRotationPick(campaign.organizationId, providers[0], rotation.mode);
  }

  const verifiedDomains = await prisma.domain.findMany({
    where: { organizationId: campaign.organizationId, status: 'VERIFIED' },
    select: { domain: true, dkimSelector: true, dkimPrivateKeyEnc: true },
  });
  const authorizedFromDomains = verifiedDomains.map((d) => d.domain);
  const linkedDomain = campaign.domain
    ? {
        domain: campaign.domain.domain,
        dkimSelector: campaign.domain.dkimSelector,
        dkimPrivateKeyEnc: campaign.domain.dkimPrivateKeyEnc,
      }
    : null;

  function dkimFor(fromEmail: string) {
    const fromDom = emailDomain(fromEmail);
    const fromVerified = verifiedDomains.find(
      (d) => fromDom === d.domain || fromDom.endsWith(`.${d.domain}`),
    );
    const match = fromVerified
      ? {
          domain: fromVerified.domain,
          dkimSelector: fromVerified.dkimSelector,
          dkimPrivateKeyEnc: fromVerified.dkimPrivateKeyEnc,
        }
      : linkedDomain;
    if (!match?.dkimPrivateKeyEnc || !match.dkimSelector) return undefined;
    try {
      return {
        domainName: match.domain,
        keySelector: match.dkimSelector,
        privateKey: decrypt(match.dkimPrivateKeyEnc),
      };
    } catch {
      return undefined;
    }
  }

  let lastError = 'Unknown error';
  for (const p of providers) {
    const cfg = parseProviderConfig(p.config);
    const identities = parseSmtpFromIdentities(cfg);
    const pinnedFrom = String(campaign.senderEmail || '').trim();
    const rotateFrom =
      !pinnedFrom || pinnedFrom === '__rotate__' || pinnedFrom.toLowerCase() === 'rotate';
    const fromEmails = identities.map((i) => i.email);
    const rotateSlot =
      rotateFrom && fromEmails.length
        ? await peekFromIdentityIndex(campaign.organizationId, p.id, fromEmails.length)
        : null;
    const requestedFrom =
      rotateSlot !== null
        ? fromEmails[rotateSlot]!
        : rotateFrom
          ? pinnedFrom || identities[0]?.email || ''
          : pinnedFrom;
    const ident = identities.find((i) => i.email.toLowerCase() === requestedFrom.toLowerCase());
    const fromName = String(
      (rotateFrom && ident?.name ? ident.name : '') ||
        input.fromName ||
        ident?.name ||
        cfg.fromName ||
        campaign.senderName ||
        '',
    ).trim();
    const resolvedFrom =
      p.type === 'SMTP'
        ? resolveSmtpFromEmail(requestedFrom || undefined, cfg, {
            authorizedDomains: authorizedFromDomains,
          })
        : { from: String(requestedFrom || cfg.fromEmail || '').trim() };
    const fromEmail = resolvedFrom.from;
    if (!fromEmail) {
      lastError = 'Sender email is required on the SMTP profile';
      continue;
    }

    const result = await sendViaProvider(
      p.type,
      p.config,
      {
        to: input.to,
        from: fromEmail,
        fromName,
        replyTo: campaign.replyTo || cfg.replyTo || undefined,
        subject: applySenderName(input.subject, fromName),
        html: applySenderName(input.html, fromName),
        text: applySenderName(input.text, fromName) || undefined,
        headers: headersForProvider(input.headers, p.type),
        dkim: dkimFor(fromEmail),
        authorizedFromDomains,
        attachments: input.attachments,
      },
      {
        portFailover: p.isDefault && p.type === 'SMTP',
        allowDirect: orgAllowsDirectSmtp({ sendSettings: campaign.organization.sendSettings }),
        reuseConnection: true,
      },
    );

    if (result.success) {
      if (rotateSlot !== null) {
        await commitFromIdentityIndex(campaign.organizationId, p.id, fromEmails.length);
      }
      if (input.countUsage !== false) {
        await prisma.emailProvider.update({
          where: { id: p.id },
          data: { sentToday: { increment: 1 }, successCount: { increment: 1 } },
        });
        await incrementHourlySent(p.id);
        await incrementMinuteSent(p.id);
      }
      return {
        success: true,
        messageId: result.messageId,
        smtpResponse: result.smtpResponse,
        providerId: p.id,
        providerName: p.name,
        providerHost: String(cfg.host || '') || null,
        fromEmail,
        providersAvailable: providers.length,
      };
    }

    lastError = result.error || lastError;
    if (isSmtpThrottleError(lastError)) {
      await writeSystemLog({
        organizationId: campaign.organizationId,
        level: 'WARNING',
        category: 'smtp',
        message: `SMTP rate-limited (${p.name}). Pausing this recipient and slowing the campaign.`,
        meta: { providerId: p.id, error: lastError },
      });
      return {
        success: false,
        error: lastError,
        throttled: true,
        retryAfterMs: throttleRetryMs(lastError, 1),
        providerId: p.id,
        providerName: p.name,
        providerHost: String(cfg.host || '') || null,
        fromEmail,
        providersAvailable: providers.length,
      };
    }
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

  return {
    success: false,
    error: lastError,
    smtpResponse: lastError,
    providersAvailable: providers.length,
  };
}

export async function sendPlacementMessage(input: {
  campaignId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  fromName?: string;
  fromEmail?: string;
  extraHeaders?: Record<string, string>;
  preferredProviderId?: string | null;
}): Promise<LiveSendResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: input.campaignId },
    include: { organization: true, domain: true },
  });
  if (!campaign) return { success: false, error: 'Campaign not found' };

  const qs = (campaign.queueSettings || {}) as { sendChannel?: 'smtp' | 'api' };
  const sendChannel = qs.sendChannel === 'api' || qs.sendChannel === 'smtp' ? qs.sendChannel : null;
  const fromName = String(input.fromName || campaign.senderName || '').trim();

  const hardened = hardenOutboundMime({
    subject: input.subject,
    previewText: campaign.previewText,
    html: input.html,
    text: input.text,
  });

  const unsubHost = emailDomain(campaign.senderEmail || '') || 'inboxflow.io';
  const origin = await trackingOrigin(campaign);
  const unsubscribeUrl = `${origin}/api/t/unsubscribe?cid=${encodeURIComponent(campaign.id)}`;
  const placed = ensureOwnUnsubscribe(
    hardened.html.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl),
    hardened.text.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl),
    unsubscribeUrl,
  );
  let html = placed.html;
  let text = placed.text;

  const headers: Record<string, string> = {
    ...listUnsubscribeHeaders(unsubscribeUrl),
    'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@${unsubHost}>`,
    'X-IF-Campaign-Id': campaign.id,
    ...(input.extraHeaders || {}),
  };

  const pinFrom = String(input.fromEmail || '').trim();
  return deliverLiveMessage({
    campaign: pinFrom ? { ...campaign, senderEmail: pinFrom, senderName: fromName || campaign.senderName } : campaign,
    to: input.to,
    html,
    text,
    subject: hardened.subject,
    fromName,
    headers,
    sendChannel,
    preferredProviderId: input.preferredProviderId ?? campaign.providerId,
    rotationEnabled: false,
    countUsage: false,
  });
}

export async function sendCampaignEmailToRecipient(input: {
  campaignId: string;
  recipientId: string;
  contactId: string;
  to: string;
  providerId?: string | null;
  cloudAuthorization?: string | null;
}): Promise<{
  success: boolean;
  messageId?: string;
  providerId?: string;
  error?: string;
  smtpResponse?: string;
  throttled?: boolean;
  retryAfterMs?: number;
  providersAvailable?: number;
  paused?: boolean;
}> {
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
    await prisma.$transaction([
      prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status: 'FAILED', error: 'Contact not subscribed' },
      }),
      prisma.campaign.update({
        where: { id: campaignId },
        data: { failedCount: { increment: 1 } },
      }),
    ]);
    return { success: false, error: 'Contact not subscribed' };
  }

  const recipientGuard = await guardRecipientAddress(to);
  if (!recipientGuard.ok) {
    await prisma.$transaction([
      prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: { status: 'FAILED', error: recipientGuard.reason },
      }),
      prisma.campaign.update({
        where: { id: campaignId },
        data: { failedCount: { increment: 1 } },
      }),
      prisma.contact.update({
        where: { id: contactId },
        data: { status: 'CLEANED' },
      }),
    ]);
    return { success: false, error: recipientGuard.reason };
  }

  const qs = (campaign.queueSettings || {}) as { sendChannel?: 'smtp' | 'api' };
  const sendChannel = qs.sendChannel === 'api' || qs.sendChannel === 'smtp' ? qs.sendChannel : null;

  const subjectBase = pickFromPool(campaign.subjectPool, campaign.subject || '');
  const fromNameBase = pickFromPool(campaign.fromNamePool, campaign.senderName || '');
  const templateIds = parseIdPool(campaign.templatePool, campaign.templateId);
  let htmlSource = campaign.htmlContent || '';
  let textSource = campaign.plainTextContent || '';
  const processed = await prisma.campaignRecipient.count({
    where: { campaignId, status: { not: 'QUEUED' } },
  });
  if (templateIds.length) {
    const chosenId = templateIds[processed % templateIds.length]!;
    const tpl = await prisma.template.findFirst({
      where: {
        id: chosenId,
        OR: [{ organizationId: campaign.organizationId }, { isPublic: true }],
      },
      select: { htmlContent: true, plainText: true },
    });
    if (tpl?.htmlContent?.trim()) {
      htmlSource = tpl.htmlContent;
      textSource = tpl.plainText || textSource;
    }
  }
  const editor =
    campaign.editorJson && typeof campaign.editorJson === 'object' && !Array.isArray(campaign.editorJson)
      ? (campaign.editorJson as {
          placeholderMap?: Record<string, string>;
          spinPools?: Record<string, string[]>;
          attachments?: Array<{ filename?: string; contentType?: string; contentBase64?: string }>;
        })
      : {};
  const mergeVars = {
    placeholderMap: editor.placeholderMap || null,
    spinPools: editor.spinPools || null,
    spinSeed: contact.email,
    physicalAddress: campaign.organization.physicalAddress,
  };
  // Contact merge tags only — {{sender_name}} is applied per attempt once From name is final.
  let html = personalize(htmlSource, contact, mergeVars);
  let text = personalize(textSource, contact, mergeVars);
  let subject = personalize(subjectBase, contact, mergeVars);

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

  const onDevice = orgKeepsWorkspaceOnDevice({ sendSettings: campaign.organization?.sendSettings });
  let origin = await trackingOrigin(campaign);
  let unsubSig = signUnsubscribe(contactId, campaignId);
  let openSig = signOpen(contactId, campaignId);
  if (onDevice) {
    try {
      const minted = await mintRelayTracking({
        authorization: input.cloudAuthorization || cloudAuthorizationFor(campaign.organizationId),
        organizationId: campaign.organizationId,
        campaignId,
        contactId,
        email: contact.email,
        urls: listTrackableLinks(html, text),
      });
      origin = preferVerifiedTrackingOrigin(origin, minted.origin || cloudTrackingOrigin());
      unsubSig = minted.unsubSig;
      openSig = minted.openSig;
      const wrapped = applyRelayClickTickets(html, text, minted.tickets, {
        origin,
        campaignId,
        contactId,
      });
      html = wrapped.html;
      text = wrapped.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Open and unsubscribe links could not be signed.';
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { status: 'PAUSED' },
      });
      await writeSystemLog({
        organizationId: campaign.organizationId,
        level: 'ERROR',
        category: 'campaign',
        message: `Send paused before SMTP: ${message}`,
        meta: { campaignId },
      });
      return { success: false, error: message, paused: true };
    }
  }
  const unsubscribeUrl = onDevice
    ? `${origin}/api/t/unsubscribe?o=${encodeURIComponent(campaign.organizationId)}&c=${encodeURIComponent(contactId)}&cid=${encodeURIComponent(campaignId)}&s=${encodeURIComponent(unsubSig)}`
    : `${origin}/api/t/unsubscribe?c=${encodeURIComponent(contactId)}&cid=${encodeURIComponent(campaignId)}&s=${encodeURIComponent(unsubSig)}`;
  const withOwnUnsubscribe = ensureOwnUnsubscribe(
    html.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl),
    text.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsubscribeUrl),
    unsubscribeUrl,
  );
  html = withOwnUnsubscribe.html;
  text = withOwnUnsubscribe.text;

  const physical = String(campaign.organization.physicalAddress || '').trim();
  if (physical && !html.toLowerCase().includes(physical.toLowerCase().slice(0, 24))) {
    const address = `<p style="font-size:12px;color:#666">${physical.replace(/</g, '&lt;')}</p>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${address}</body>`) : `${html}${address}`;
  }
  if (physical && !text.toLowerCase().includes(physical.toLowerCase().slice(0, 24))) {
    text = `${text}\n${physical}`.trim();
  }

  if (processed === 0) {
    const linkWarning = isLoopbackPublicUrl(origin)
      ? 'Open, click, and unsubscribe links point at this PC only. Bind the public address first so mailbox providers can reach them.'
      : !isMailboxProviderTrackingOrigin(origin)
        ? 'Open, click, and unsubscribe links are not on https port 443 with a domain name. Office 365, Gmail, and other providers check that link before they accept mail. Point PUBLIC_URL at https://your-domain.'
        : '';
    if (linkWarning) {
      await writeSystemLog({
        organizationId: campaign.organizationId,
        level: 'WARNING',
        category: 'campaign',
        message: linkWarning,
        meta: { campaignId, origin },
      });
    }
  }

  if (campaign.trackOpens) {
    const openQuery = onDevice
      ? `o=${encodeURIComponent(campaign.organizationId)}&s=${encodeURIComponent(openSig)}`
      : `s=${encodeURIComponent(openSig)}`;
    const pixel = `<img src="${origin}/api/t/o/${campaignId}/${contactId}.gif?${openQuery}" width="1" height="1" alt="" border="0" style="height:1px;width:1px;border:0;margin:0;padding:0" />`;
    html = html.replace(/<\/body>/i, `${pixel}</body>`);
    if (!html.includes(pixel)) html += pixel;
  }

  const headers: Record<string, string> = {
    ...listUnsubscribeHeaders(unsubscribeUrl),
    // Correlate ESP webhooks (Brevo/SendGrid/etc.) back to this recipient
    'X-IF-Campaign-Id': campaignId,
    'X-IF-Recipient-Id': recipientId,
    'X-IF-Contact-Id': contactId,
    'X-Mailin-custom': JSON.stringify({ campaignId, recipientId, contactId }),
  };
  const attachments = (editor.attachments || [])
    .filter((a) => a?.filename && a.contentBase64)
    .slice(0, 3)
    .map((a) => ({
      filename: String(a.filename),
      contentType: a.contentType || 'application/octet-stream',
      content: String(a.contentBase64),
      encoding: 'base64',
    }));

  const live = await deliverLiveMessage({
    campaign,
    to,
    html,
    text,
    subject,
    fromName: fromNameBase,
    headers,
    sendChannel,
    preferredProviderId: input.providerId ?? campaign.providerId,
    rotationEnabled: parseRotationSettings(campaign.organization.sendSettings).enabled,
    countUsage: true,
    fromRotateIndex: processed,
    attachments,
  });

  if (live.success) {
    // SMTP accept ≠ inbox folder. Mark SENT only; DELIVERED/BOUNCED come from ESP webhooks.
    await prisma.$transaction([
      prisma.campaignRecipient.update({
        where: { id: recipientId },
        data: {
          status: 'SENT',
          messageId: live.messageId,
          sentAt: new Date(),
          error: null,
          smtpResponse: live.smtpResponse || null,
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
          messageId: live.messageId,
          metadata: live.smtpResponse ? { smtpResponse: live.smtpResponse, providerId: live.providerId } : undefined,
        },
      }),
    ]);
    return {
      success: true,
      messageId: live.messageId,
      providerId: live.providerId,
      smtpResponse: live.smtpResponse,
      providersAvailable: live.providersAvailable,
    };
  }

  if (live.throttled) {
    return {
      success: false,
      error: live.error,
      throttled: true,
      retryAfterMs: live.retryAfterMs,
      providerId: live.providerId,
      smtpResponse: live.smtpResponse,
      providersAvailable: live.providersAvailable,
    };
  }

  const kind = classifySmtpRecipientResult(`${live.smtpResponse || ''} ${live.error || ''}`);
  const status = smtpRecipientStatus(kind);
  const bounced = status === 'BOUNCED';
  await prisma.$transaction([
    prisma.campaignRecipient.update({
      where: { id: recipientId },
      data: {
        status,
        error: live.error || 'Send failed',
        smtpResponse: live.smtpResponse || live.error || null,
        ...(bounced ? { bouncedAt: new Date() } : {}),
      },
    }),
    prisma.campaign.update({
      where: { id: campaignId },
      data: bounced
        ? { bouncedCount: { increment: 1 } }
        : { failedCount: { increment: 1 } },
    }),
  ]);
  if (bounced) {
    const { enqueueBounce } = await import('./queue.js');
    await enqueueBounce({
      email: to,
      type: kind === 'soft_bounce' ? 'SOFT' : 'HARD',
      organizationId: campaign.organizationId,
      campaignId,
      recipientId,
      contactId,
      reason: live.error || live.smtpResponse || kind,
    });
  }
  await maybePauseOnFailRate(campaignId, campaign.organizationId);

  return {
    success: false,
    error: live.error,
    smtpResponse: live.smtpResponse || live.error,
    providersAvailable: live.providersAvailable,
  };
}

export { personalize, firstNameFromEmail } from './personalize.js';
