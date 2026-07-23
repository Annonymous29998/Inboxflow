import { getServiceClient } from './auth.ts';
import {
  buildTrackBaseUrl,
  signClickRedirect,
} from './signed-urls.ts';
import { resolveSmtpProvider, sendViaSmtp } from './smtp.ts';
import { buildDeliverabilityHeaders, htmlToPlainText, stripAppUnsubscribeTokens, validateCampaignContent } from './deliverability.ts';

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function invokeBackgroundWorker(campaignId: string) {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const serviceKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    console.error('[background-worker] Missing SUPABASE_URL or service role key');
    return;
  }

  fetch(`${supabaseUrl}/functions/v1/campaign-background-worker`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ campaignId }),
  }).catch((err) => console.error('[background-worker] chain invoke failed', err));
}

export async function finalizeCampaignIfDone(db: ReturnType<typeof getServiceClient>, campaignId: string) {
  const [{ count: sentCount }, { count: failedCount }, { count: pendingCount }] = await Promise.all([
    db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'SENT'),
    db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'FAILED'),
    db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'QUEUED'),
  ]);

  const sent = sentCount ?? 0;
  const failed = failedCount ?? 0;
  const pending = pendingCount ?? 0;

  if (pending > 0) return { done: false, sent, failed, pending };

  const status = failed > 0 && sent === 0 ? 'FAILED' : 'SENT';
  await db.from('Campaign').update({
    status,
    sentCount: sent,
    completedAt: new Date().toISOString(),
  }).eq('id', campaignId);

  return { done: true, sent, failed, pending: 0, status };
}

export async function processCampaignBatch(campaignId: string, options?: { maxRuntimeMs?: number }) {
  const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
  if (!encryptionKey || encryptionKey.length < 32) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }

  const db = getServiceClient();
  const maxRuntimeMs = options?.maxRuntimeMs ?? 120_000;
  const started = Date.now();

  const { data: campaign, error: campaignError } = await db
    .from('Campaign')
    .select(
      'id, organizationId, status, subject, htmlContent, plainTextContent, providerId, senderEmail, senderName, replyTo, trackOpens, trackClicks, domainId, queueSettings',
    )
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError) throw campaignError;
  if (!campaign) throw new Error('Campaign not found');
  if (['PAUSED', 'CANCELLED', 'SENT'].includes(String(campaign.status))) {
    return { processed: 0, continued: false, reason: `campaign_${String(campaign.status).toLowerCase()}` };
  }

  const queueSettings = (campaign.queueSettings || {}) as {
    betweenEmailMs?: number;
    batchSize?: number;
    batchPauseMs?: number;
  };
  const betweenEmailMs = queueSettings.betweenEmailMs ?? 500;
  const batchSize = queueSettings.batchSize ?? 10;
  const batchPauseMs = queueSettings.batchPauseMs ?? 5000;

  let processed = 0;
  let sentInBatch = 0;

  while (Date.now() - started < maxRuntimeMs) {
    const live = await db.from('Campaign').select('status').eq('id', campaignId).maybeSingle();
    if (!live?.status || ['PAUSED', 'CANCELLED'].includes(String(live.status))) {
      break;
    }

    if (sentInBatch >= batchSize) {
      sentInBatch = 0;
      await sleep(batchPauseMs);
      continue;
    }

    const { data: recipient } = await db
      .from('CampaignRecipient')
      .select('id, contactId')
      .eq('campaignId', campaignId)
      .eq('status', 'QUEUED')
      .order('createdAt', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!recipient) {
      await finalizeCampaignIfDone(db, campaignId);
      return { processed, continued: false, done: true };
    }

    const { data: contact } = await db
      .from('Contact')
      .select('id, email, firstName, lastName, status, customData')
      .eq('id', recipient.contactId)
      .maybeSingle();

    if (!contact || contact.status !== 'SUBSCRIBED') {
      await db.from('CampaignRecipient').update({ status: 'FAILED', error: 'Contact not subscribed' }).eq('id', recipient.id);
      processed += 1;
      sentInBatch += 1;
      continue;
    }

    const orgId = String(campaign.organizationId);
    const { data: org } = await db.from('Organization').select('name, physicalAddress').eq('id', orgId).maybeSingle();

    let domainName: string | null = null;
    if (campaign.domainId) {
      const { data: domain } = await db.from('Domain').select('domain').eq('id', campaign.domainId).maybeSingle();
      domainName = domain?.domain ? String(domain.domain) : null;
    }

    const smtp = await resolveSmtpProvider(db, orgId, campaign.providerId as string | null, encryptionKey);
    const validated = validateCampaignContent(String(campaign.subject || ''), String(campaign.htmlContent || ''));
    const trackBase = buildTrackBaseUrl();
    const contactId = String(contact.id);
    const to = String(contact.email);

    let html = stripAppUnsubscribeTokens(
      personalize(validated.sanitizedHtml, {
        firstName: contact.firstName as string | null,
        lastName: contact.lastName as string | null,
        email: to,
        customData: contact.customData,
      }),
    );
    let text = stripAppUnsubscribeTokens(
      personalize(String(campaign.plainTextContent || htmlToPlainText(html)), {
        firstName: contact.firstName as string | null,
        lastName: contact.lastName as string | null,
        email: to,
        customData: contact.customData,
      }),
    );

    if (campaign.trackOpens) {
      const pixel =
        `<img src="${trackBase}?action=open&campaignId=${campaignId}&contactId=${contactId}" width="1" height="1" alt="" style="display:none" />`;
      html = html.replace(/<\/body>/i, `${pixel}</body>`);
      if (!html.includes(pixel)) html += pixel;
    }

    if (campaign.trackClicks) {
      html = html.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (_m, url: string) => {
        const sig = signClickRedirect(campaignId, contactId, url);
        const tracked =
          `${trackBase}?action=click&campaignId=${campaignId}&contactId=${contactId}&u=${encodeURIComponent(url)}&s=${sig}`;
        return `href="${tracked}"`;
      });
    }

    const fromEmail =
      campaign.senderEmail || smtp.fromEmail || smtp.user || `noreply@${domainName || 'localhost'}`;
    const fromName = campaign.senderName || smtp.fromName || org?.name || 'Inbox Flow';

    try {
      const result = await sendViaSmtp(
        {
          to,
          subject: personalize(validated.sanitizedSubject, {
            firstName: contact.firstName as string | null,
            lastName: contact.lastName as string | null,
            email: to,
            customData: contact.customData,
          }),
          html,
          text: text || undefined,
          fromEmail: String(fromEmail),
          fromName: String(fromName),
          replyTo: campaign.replyTo ? String(campaign.replyTo) : smtp.replyTo,
          headers: buildDeliverabilityHeaders(campaign.replyTo ? String(campaign.replyTo) : smtp.replyTo),
        },
        smtp,
      );

      await db.from('CampaignRecipient').update({
        status: 'SENT',
        messageId: result.messageId,
        sentAt: new Date().toISOString(),
        error: null,
      }).eq('id', recipient.id);

      const { data: currentCampaign } = await db.from('Campaign').select('sentCount').eq('id', campaignId).maybeSingle();
      await db.from('Campaign').update({ sentCount: Number(currentCampaign?.sentCount ?? 0) + 1 }).eq('id', campaignId);

      await db.from('TrackingEvent').insert({
        type: 'SENT',
        campaignId,
        contactId,
        messageId: result.messageId,
      });

      if (smtp.id !== 'default') {
        const { data: providerRow } = await db.from('EmailProvider').select('sentToday').eq('id', smtp.id).maybeSingle();
        await db.from('EmailProvider').update({ sentToday: Number(providerRow?.sentToday ?? 0) + 1 }).eq('id', smtp.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Send failed';
      await db.from('CampaignRecipient').update({ status: 'FAILED', error: message }).eq('id', recipient.id);
    }

    processed += 1;
    sentInBatch += 1;
    await sleep(betweenEmailMs);
  }

  const { count: pendingCount } = await db
    .from('CampaignRecipient')
    .select('id', { count: 'exact', head: true })
    .eq('campaignId', campaignId)
    .eq('status', 'QUEUED');

  const pending = pendingCount ?? 0;
  if (pending > 0) {
    await invokeBackgroundWorker(campaignId);
    return { processed, continued: true, pending };
  }

  await finalizeCampaignIfDone(db, campaignId);
  return { processed, continued: false, done: true };
}
