import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient, requireOrg, verifyInboxFlowJwt } from '../_shared/auth.ts';
import { invokeBackgroundWorker } from '../_shared/background-worker.ts';
import {
  buildTrackBaseUrl,
  signClickRedirect,
} from '../_shared/signed-urls.ts';
import { resolveSmtpProvider, sendViaSmtp } from '../_shared/smtp.ts';
import { buildDeliverabilityHeaders, detectSmtpDeliverabilityWarnings, htmlToPlainText, stripAppUnsubscribeTokens, validateCampaignContent } from '../_shared/deliverability.ts';
import {
  findRemainingSpamPhrases,
  isImageOnlyHtml,
  scrubCampaignContent,
  stripHtmlTags,
} from '../_shared/spam-content-filter.ts';

function cuidLike(): string {
  const rnd = (len: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(Math.ceil(len * 0.75))))
      .map((b) => b.toString(36).padStart(2, '0'))
      .join('')
      .slice(0, len);
  return `c${rnd(24)}`;
}

function personalize(
  template: string,
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    customData?: unknown;
  },
  vars?: { senderName?: string | null },
) {
  const custom = (contact.customData || {}) as Record<string, string>;
  const deferred = new Set(['sender_name', 'sendername', 'unsubscribe_url', 'physical_address']);
  const senderName = String(vars?.senderName ?? '').trim();
  let out = template
    .replace(/\{\{\s*firstName\s*\}\}/gi, contact.firstName || '')
    .replace(/\{\{\s*lastName\s*\}\}/gi, contact.lastName || '')
    .replace(/\{\{\s*email\s*\}\}/gi, contact.email)
    .replace(
      /\{\{\s*name\s*\}\}/gi,
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email,
    );
  if (vars && Object.prototype.hasOwnProperty.call(vars, 'senderName')) {
    out = out
      .replace(/\{\{\s*sender_name\s*\}\}/gi, senderName)
      .replace(/\{\{\s*senderName\s*\}\}/gi, senderName);
  }
  return out.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    if (deferred.has(String(key).toLowerCase())) return match;
    return custom[key] ?? '';
  });
}

async function collectListContacts(db: ReturnType<typeof getServiceClient>, organizationId: string, listId: string) {
  const { data: members, error: membersError } = await db
    .from('ContactListMember')
    .select('contactId')
    .eq('listId', listId);

  if (membersError) throw membersError;

  const contactIds = (members ?? []).map((row) => String(row.contactId)).filter(Boolean);
  if (!contactIds.length) return [];

  const { data: contacts, error: contactsError } = await db
    .from('Contact')
    .select('id, email, firstName, lastName, status, customData')
    .in('id', contactIds)
    .eq('status', 'SUBSCRIBED');

  if (contactsError) throw contactsError;
  if (!contacts?.length) return [];

  const emails = contacts.map((c) => String(c.email));
  const { data: suppressed } = await db
    .from('SuppressionList')
    .select('email')
    .eq('organizationId', organizationId)
    .in('email', emails);

  const suppressedSet = new Set((suppressed ?? []).map((s) => String(s.email).toLowerCase()));
  return contacts.filter((c) => !suppressedSet.has(String(c.email).toLowerCase()));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const auth = await verifyInboxFlowJwt(req);
    if (auth instanceof Response) return auth;

    const encryptionKey = Deno.env.get('ENCRYPTION_KEY');
    if (!encryptionKey || encryptionKey.length < 32) {
      return jsonResponse({ error: 'ENCRYPTION_KEY is not configured on Edge Functions' }, 500);
    }

    const orgId = requireOrg(auth.organizationId);
    const db = getServiceClient();
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action ?? 'send-one').trim().toLowerCase();
    const campaignId = String(body.campaignId ?? '').trim();
    const createdById = typeof (auth as any).userId === 'string' ? String((auth as any).userId) : null;

    if (!campaignId) {
      return jsonResponse({ error: 'campaignId is required' }, 400);
    }

    const { data: campaign, error: campaignError } = await db
      .from('Campaign')
      .select(
        'id, organizationId, status, subject, previewText, htmlContent, plainTextContent, listId, segmentId, providerId, senderEmail, senderName, replyTo, trackOpens, trackClicks, domainId',
      )
      .eq('id', campaignId)
      .eq('organizationId', orgId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) return jsonResponse({ error: 'Campaign not found' }, 404);

    async function upsertJob(input: {
      id?: string;
      type?: 'CONTACT_IMPORT' | 'CAMPAIGN_SEND' | 'LIST_CLEAR' | 'CONTACT_EXPORT' | 'TEMPLATE_RENDER' | 'DELIVERABILITY_ANALYZE';
      total?: number;
      processed?: number;
      status?: 'PENDING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
      meta?: Record<string, unknown>;
      error?: string;
      resourceId?: string;
    }) {
      try {
        const id = input.id || cuidLike();
        const type = input.type || 'CAMPAIGN_SEND';
        const status = input.status || 'RUNNING';
        const payload: Record<string, unknown> = {
          id,
          type,
          status,
          organizationId: orgId,
          resourceId: input.resourceId ?? campaignId,
          campaignId,
          total: Number(input.total ?? 0),
          processed: Number(input.processed ?? 0),
          meta: input.meta ?? {},
        };
        if (createdById) payload.createdById = createdById;
        if (input.startedAt !== undefined) payload.startedAt = input.startedAt;
        if (input.error) payload.error = input.error;
        if (input.finishedAt !== undefined) payload.finishedAt = input.finishedAt;

        const { data, error } = await db
          .from('Job')
          .upsert(payload, { onConflict: 'id', ignoreDuplicates: false })
          .select('*')
          .maybeSingle();
        if (error) console.warn('[send-campaign-email] job upsert failed', error);
        return (data?.id as string) || id;
      } catch {
        return input.id || cuidLike();
      }
    }

    const passedJobId = body.jobId ? String(body.jobId) : null;

    if (action === 'prepare') {
      // Scrub spam phrases and enforce last-resort hard-block (also below in background-start + send-one)
      const scrubbed = scrubCampaignContent({
        subject: String(campaign.subject || ''),
        previewText: String(campaign.previewText || ''),
        htmlContent: String(campaign.htmlContent || ''),
        plainTextContent: String(campaign.plainTextContent || ''),
      });
      if (scrubbed.changed) {
        const updatePayload: Record<string, unknown> = {
          subject: scrubbed.subject,
          previewText: scrubbed.previewText,
          htmlContent: scrubbed.htmlContent,
          plainTextContent: scrubbed.plainTextContent,
        };
        const { error } = await db.from('Campaign').update(updatePayload).eq('id', campaignId);
        if (error) throw error;
        campaign.subject = scrubbed.subject;
        campaign.previewText = scrubbed.previewText;
        campaign.htmlContent = scrubbed.htmlContent;
        campaign.plainTextContent = scrubbed.plainTextContent;
      }
      const remaining = findRemainingSpamPhrases(
        `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.plainTextContent}\n${stripHtmlTags(scrubbed.htmlContent)}`,
      );
      const blockers: string[] = [];
      if (!scrubbed.subject.trim()) blockers.push('empty subject');
      if (isImageOnlyHtml(scrubbed.htmlContent)) blockers.push('image-only content (no readable text)');
      if (campaign.unsubscribeMode === 'NONE' && !campaign.includeUnsubscribeLink) {
        blockers.push('no unsubscribe link / mode configured (CAN-SPAM / GDPR required)');
      }
      if (remaining.length > 0) blockers.push(`remaining high-risk spam phrases: ${remaining.slice(0, 3).join(', ')}`);
      if (blockers.length > 0) {
        await db.from('Campaign').update({
          status: 'FAILED',
          failReason: `Send cancelled by content filter. Fix: ${blockers.join('; ')}`,
          failedAt: new Date().toISOString(),
        }).eq('id', campaignId);
        return jsonResponse({ error: `Campaign blocked by content filter: ${blockers.join('; ')}`, scrubbedRemoved: scrubbed.removed }, 400);
      }
      if (!campaign.subject || !campaign.htmlContent) {
        return jsonResponse({ error: 'Campaign needs subject and content before sending' }, 400);
      }
      if (!campaign.listId && !campaign.segmentId) {
        return jsonResponse({ error: 'Select a list or segment' }, 400);
      }
      if (campaign.segmentId && !campaign.listId) {
        return jsonResponse({
          error: 'Segment-based campaigns require the Fastify API for prepare-send. Use a contact list for Supabase-only sending.',
        }, 400);
      }

      const contacts = await collectListContacts(db, orgId, String(campaign.listId));
      if (!contacts.length) {
        return jsonResponse({ error: 'No eligible recipients' }, 400);
      }

      const providerId = body.providerId === undefined ? campaign.providerId : (body.providerId as string | null);
      const smtp = providerId
        ? await resolveSmtpProvider(db, orgId, providerId as string | null, encryptionKey)
        : null;
      const deliverabilityWarnings = smtp
        ? detectSmtpDeliverabilityWarnings({
          host: smtp.host,
          port: smtp.port,
          fromEmail: String(campaign.senderEmail || smtp.fromEmail || smtp.user || ''),
          user: smtp.user,
        })
        : [];

      const recipients = [];
      for (const contact of contacts) {
        const contactId = String(contact.id);
        const { data: existing } = await db
          .from('CampaignRecipient')
          .select('id')
          .eq('campaignId', campaignId)
          .eq('contactId', contactId)
          .maybeSingle();

        if (existing?.id) {
          await db
            .from('CampaignRecipient')
            .update({ status: 'QUEUED', error: null, messageId: null, sentAt: null })
            .eq('id', existing.id);
          recipients.push({
            id: existing.id,
            contactId,
            email: String(contact.email),
            displayName:
              [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
              String(contact.email).split('@')[0],
          });
        } else {
          const { data: created, error: createError } = await db
            .from('CampaignRecipient')
            .insert({
              campaignId,
              contactId,
              status: 'QUEUED',
            })
            .select('id')
            .single();
          if (createError) throw createError;
          recipients.push({
            id: created.id,
            contactId,
            email: String(contact.email),
            displayName:
              [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
              String(contact.email).split('@')[0],
          });
        }
      }

      await db
        .from('Campaign')
        .update({
          status: 'SENDING',
          sentAt: new Date().toISOString(),
          sentCount: 0,
          failedCount: 0,
          totalRecipients: contacts.length,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
        })
        .eq('id', campaignId);

      const jobId = await upsertJob({
        id: passedJobId || undefined,
        type: 'CAMPAIGN_SEND',
        total: contacts.length,
        processed: 0,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        meta: { stage: 'prepared', sent: 0, failed: 0, pending: contacts.length, deliverabilityWarnings },
      });

      return jsonResponse({
        success: true,
        recipients,
        totalRecipients: contacts.length,
        jobId,
        deliverabilityWarnings,
      });
    }

    if (action === 'background-start') {
      // Scrub + last-resort hard-block
      const scrubbed = scrubCampaignContent({
        subject: String(campaign.subject || ''),
        previewText: String(campaign.previewText || ''),
        htmlContent: String(campaign.htmlContent || ''),
        plainTextContent: String(campaign.plainTextContent || ''),
      });
      if (scrubbed.changed) {
        const updatePayload: Record<string, unknown> = {
          subject: scrubbed.subject,
          previewText: scrubbed.previewText,
          htmlContent: scrubbed.htmlContent,
          plainTextContent: scrubbed.plainTextContent,
        };
        const { error } = await db.from('Campaign').update(updatePayload).eq('id', campaignId);
        if (error) throw error;
        campaign.subject = scrubbed.subject;
        campaign.previewText = scrubbed.previewText;
        campaign.htmlContent = scrubbed.htmlContent;
        campaign.plainTextContent = scrubbed.plainTextContent;
      }
      const remaining = findRemainingSpamPhrases(
        `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.plainTextContent}\n${stripHtmlTags(scrubbed.htmlContent)}`,
      );
      const blockers: string[] = [];
      if (!scrubbed.subject.trim()) blockers.push('empty subject');
      if (isImageOnlyHtml(scrubbed.htmlContent)) blockers.push('image-only content (no readable text)');
      if (campaign.unsubscribeMode === 'NONE' && !campaign.includeUnsubscribeLink) {
        blockers.push('no unsubscribe link / mode configured (CAN-SPAM / GDPR required)');
      }
      if (remaining.length > 0) blockers.push(`remaining high-risk spam phrases: ${remaining.slice(0, 3).join(', ')}`);
      if (blockers.length > 0) {
        await db.from('Campaign').update({
          status: 'FAILED',
          failReason: `Send cancelled by content filter. Fix: ${blockers.join('; ')}`,
          failedAt: new Date().toISOString(),
        }).eq('id', campaignId);
        return jsonResponse({ error: `Campaign blocked by content filter: ${blockers.join('; ')}`, scrubbedRemoved: scrubbed.removed }, 400);
      }
      if (!campaign.subject || !campaign.htmlContent) {
        return jsonResponse({ error: 'Campaign needs subject and content before sending' }, 400);
      }
      if (!campaign.listId && !campaign.segmentId) {
        return jsonResponse({ error: 'Select a list or segment' }, 400);
      }
      if (campaign.segmentId && !campaign.listId) {
        return jsonResponse({
          error: 'Segment-based campaigns require the Fastify API. Use a contact list for Supabase-only sending.',
        }, 400);
      }

      const queueSettings = body.queueSettings && typeof body.queueSettings === 'object'
        ? body.queueSettings
        : null;

      const contacts = await collectListContacts(db, orgId, String(campaign.listId));
      if (!contacts.length) {
        return jsonResponse({ error: 'No eligible recipients' }, 400);
      }

      for (const contact of contacts) {
        const contactId = String(contact.id);
        const { data: existing } = await db
          .from('CampaignRecipient')
          .select('id')
          .eq('campaignId', campaignId)
          .eq('contactId', contactId)
          .maybeSingle();

        if (existing?.id) {
          await db
            .from('CampaignRecipient')
            .update({ status: 'QUEUED', error: null, messageId: null, sentAt: null })
            .eq('id', existing.id);
        } else {
          const { error: createError } = await db.from('CampaignRecipient').insert({
            campaignId,
            contactId,
            status: 'QUEUED',
          });
          if (createError) throw createError;
        }
      }

      await db
        .from('Campaign')
        .update({
          status: 'SENDING',
          sentAt: new Date().toISOString(),
          sentCount: 0,
          failedCount: 0,
          totalRecipients: contacts.length,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
          ...(queueSettings ? { queueSettings } : {}),
        })
        .eq('id', campaignId);

      const jobId = await upsertJob({
        id: passedJobId || undefined,
        type: 'CAMPAIGN_SEND',
        total: contacts.length,
        processed: 0,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        meta: { stage: 'prepared', sent: 0, failed: 0, pending: contacts.length },
      });

      await invokeBackgroundWorker(campaignId);

      return jsonResponse({
        success: true,
        background: true,
        totalRecipients: contacts.length,
        status: 'SENDING',
        jobId,
      });
    }

    if (action === 'status') {
      const [{ count: sentCount }, { count: failedCount }, { count: pendingCount }] = await Promise.all([
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'SENT'),
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'FAILED'),
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'QUEUED'),
      ]);

      const { data: live } = await db
        .from('Campaign')
        .select('status, totalRecipients, sentCount, failedCount, completedAt')
        .eq('id', campaignId)
        .maybeSingle();

      return jsonResponse({
        success: true,
        status: live?.status ?? campaign.status,
        totalRecipients: live?.totalRecipients ?? 0,
        sentCount: sentCount ?? 0,
        failedCount: failedCount ?? 0,
        pendingCount: pendingCount ?? 0,
        completedAt: live?.completedAt ?? null,
      });
    }

    if (action === 'finalize') {
      const cancelled = Boolean(body.cancelled);
      const [{ count: sentCount }, { count: failedCount }, { count: pendingCount }] = await Promise.all([
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'SENT'),
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'FAILED'),
        db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'QUEUED'),
      ]);

      const sent = Number(sentCount ?? 0);
      const failed = Number(failedCount ?? 0);
      const pending = Number(pendingCount ?? 0);

      const status = cancelled
        ? 'CANCELLED'
        : pending > 0
        ? 'PAUSED'
        : failed > 0 && sent === 0
        ? 'FAILED'
        : 'SENT';

      await db
        .from('Campaign')
        .update({
          status,
          sentCount: sent,
          failedCount: failed,
          completedAt: status === 'SENT' || status === 'CANCELLED' ? new Date().toISOString() : null,
        })
        .eq('id', campaignId);

      if (passedJobId) {
        const jobStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED' = status === 'CANCELLED'
          ? 'CANCELLED'
          : status === 'FAILED'
          ? 'FAILED'
          : status === 'PAUSED'
          ? 'PAUSED'
          : 'COMPLETED';
        await upsertJob({
          id: passedJobId,
          status: jobStatus,
          processed: sent + failed,
          total: Math.max(sent + failed + pending, 1),
          finishedAt: new Date().toISOString(),
          meta: {
            stage: jobStatus === 'COMPLETED' ? 'completed' : 'finalized',
            sent,
            failed,
            pending,
          },
        });
      }

      return jsonResponse({
        success: true,
        sentCount: sent,
        failedCount: failed,
        pendingCount: pending,
        status,
        jobId: passedJobId || null,
      });
    }

    if (action === 'send-one') {
      const recipientId = String(body.recipientId ?? '').trim();
      if (!recipientId) {
        return jsonResponse({ error: 'recipientId is required' }, 400);
      }

      // Scrub + last-resort hard-block
      const scrubbed = scrubCampaignContent({
        subject: String(campaign.subject || ''),
        previewText: String(campaign.previewText || ''),
        htmlContent: String(campaign.htmlContent || ''),
        plainTextContent: String(campaign.plainTextContent || ''),
      });
      if (scrubbed.changed) {
        const updatePayload: Record<string, unknown> = {
          subject: scrubbed.subject,
          previewText: scrubbed.previewText,
          htmlContent: scrubbed.htmlContent,
          plainTextContent: scrubbed.plainTextContent,
        };
        const { error } = await db.from('Campaign').update(updatePayload).eq('id', campaignId);
        if (error) throw error;
        campaign.subject = scrubbed.subject;
        campaign.previewText = scrubbed.previewText;
        campaign.htmlContent = scrubbed.htmlContent;
        campaign.plainTextContent = scrubbed.plainTextContent;
      }
      const remaining = findRemainingSpamPhrases(
        `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.plainTextContent}\n${stripHtmlTags(scrubbed.htmlContent)}`,
      );
      const blockers: string[] = [];
      if (!scrubbed.subject.trim()) blockers.push('empty subject');
      if (isImageOnlyHtml(scrubbed.htmlContent)) blockers.push('image-only content (no readable text)');
      if (campaign.unsubscribeMode === 'NONE' && !campaign.includeUnsubscribeLink) {
        blockers.push('no unsubscribe link / mode configured (CAN-SPAM / GDPR required)');
      }
      if (remaining.length > 0) blockers.push(`remaining high-risk spam phrases: ${remaining.slice(0, 3).join(', ')}`);
      if (blockers.length > 0) {
        await db.from('Campaign').update({
          status: 'FAILED',
          failReason: `Send cancelled by content filter. Fix: ${blockers.join('; ')}`,
          failedAt: new Date().toISOString(),
        }).eq('id', campaignId);
        await db.from('CampaignRecipient').update({
          status: 'FAILED',
          error: 'Campaign blocked by content filter',
        }).eq('campaignId', campaignId).eq('id', recipientId);
        return jsonResponse({
          success: false,
          error: `Campaign blocked by content filter: ${blockers.join('; ')}`,
          scrubbedRemoved: scrubbed.removed,
          jobId: passedJobId || null,
        }, 400);
      }

      if (['PAUSED', 'CANCELLED'].includes(String(campaign.status))) {
        return jsonResponse({ error: `Campaign is ${String(campaign.status).toLowerCase()}` }, 400);
      }

      const { data: recipient, error: recipientError } = await db
        .from('CampaignRecipient')
        .select('id, contactId, status')
        .eq('id', recipientId)
        .eq('campaignId', campaignId)
        .maybeSingle();

      if (recipientError) throw recipientError;
      if (!recipient) return jsonResponse({ error: 'Recipient not found' }, 404);

      const { data: contact, error: contactError } = await db
        .from('Contact')
        .select('id, email, firstName, lastName, status, customData')
        .eq('id', recipient.contactId)
        .maybeSingle();

      if (contactError) throw contactError;
      if (!contact || contact.status !== 'SUBSCRIBED') {
        await db
          .from('CampaignRecipient')
          .update({ status: 'FAILED', error: 'Contact not subscribed' })
          .eq('id', recipientId);
        return jsonResponse({ success: false, error: 'Contact not subscribed', jobId: passedJobId || null }, 400);
      }

      const { data: org } = await db
        .from('Organization')
        .select('name, physicalAddress')
        .eq('id', orgId)
        .maybeSingle();

      let domainName: string | null = null;
      if (campaign.domainId) {
        const { data: domain } = await db
          .from('Domain')
          .select('domain')
          .eq('id', campaign.domainId)
          .maybeSingle();
        domainName = domain?.domain ? String(domain.domain) : null;
      }

      const providerId = body.providerId === undefined ? campaign.providerId : body.providerId;
      const smtp = await resolveSmtpProvider(db, orgId, providerId as string | null, encryptionKey);

      const validated = validateCampaignContent(String(campaign.subject || ''), String(campaign.htmlContent || ''));

      const trackBase = buildTrackBaseUrl();
      const contactId = String(contact.id);
      const to = String(contact.email);

      const fromName = String(campaign.senderName || smtp.fromName || '').trim();
      const fromEmail = String(
        campaign.senderEmail || smtp.fromEmail || smtp.user || '',
      ).trim();
      if (!fromEmail) {
        return jsonResponse(
          { error: 'Sender email is required. Set it on the campaign or SMTP profile.', jobId: passedJobId || null },
          400,
        );
      }

      let html = stripAppUnsubscribeTokens(
        personalize(
          validated.sanitizedHtml,
          {
            firstName: contact.firstName as string | null,
            lastName: contact.lastName as string | null,
            email: to,
            customData: contact.customData,
          },
          { senderName: fromName },
        ),
      );
      let text = stripAppUnsubscribeTokens(
        personalize(
          String(campaign.plainTextContent || htmlToPlainText(html)),
          {
            firstName: contact.firstName as string | null,
            lastName: contact.lastName as string | null,
            email: to,
            customData: contact.customData,
          },
          { senderName: fromName },
        ),
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

      try {
        const result = await sendViaSmtp(
          {
            to,
            subject: personalize(
              validated.sanitizedSubject,
              {
                firstName: contact.firstName as string | null,
                lastName: contact.lastName as string | null,
                email: to,
                customData: contact.customData,
              },
              { senderName: fromName },
            ),
            html,
            text: text || undefined,
            fromEmail,
            fromName,
            replyTo: campaign.replyTo ? String(campaign.replyTo) : smtp.replyTo,
            headers: buildDeliverabilityHeaders(campaign.replyTo ? String(campaign.replyTo) : smtp.replyTo),
          },
          smtp,
        );

        const { data: updatedRecipient } = await db.from('CampaignRecipient').update({
          status: 'SENT',
          messageId: result.messageId,
          sentAt: new Date().toISOString(),
          error: null,
        }).eq('id', recipientId).select('*').maybeSingle();
        void updatedRecipient;

        const [{ count: sentCountRes }, { count: failedCountRes }, { count: pendingCountRes }] = await Promise.all([
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'SENT'),
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'FAILED'),
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'QUEUED'),
        ]);
        const sent = Number(sentCountRes ?? 0);
        const failed = Number(failedCountRes ?? 0);
        const pending = Number(pendingCountRes ?? 0);

        await db.from('Campaign').update({
          sentCount: sent,
          failedCount: failed,
          status: 'SENDING',
        }).eq('id', campaignId);

        if (passedJobId) {
          await upsertJob({
            id: passedJobId,
            status: 'RUNNING',
            processed: sent + failed,
            total: Math.max(sent + failed + pending, 1),
            meta: {
              stage: 'sending',
              sent,
              failed,
              pending,
              lastEmail: to,
            },
          });
        }

        await db.from('TrackingEvent').insert({
          type: 'SENT',
          campaignId,
          contactId,
          messageId: result.messageId,
        });

        if (smtp.id !== 'default') {
          const { data: providerRow } = await db
            .from('EmailProvider')
            .select('sentToday')
            .eq('id', smtp.id)
            .maybeSingle();
          await db.from('EmailProvider').update({
            sentToday: Number(providerRow?.sentToday ?? 0) + 1,
          }).eq('id', smtp.id);
        }

        return jsonResponse({ success: true, messageId: result.messageId, jobId: passedJobId || null });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Send failed';
        await db.from('CampaignRecipient').update({ status: 'FAILED', error: message }).eq('id', recipientId);

        const [{ count: sentCountRes }, { count: failedCountRes }, { count: pendingCountRes }] = await Promise.all([
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'SENT'),
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'FAILED'),
          db.from('CampaignRecipient').select('id', { count: 'exact', head: true }).eq('campaignId', campaignId).eq('status', 'QUEUED'),
        ]);
        const sent = Number(sentCountRes ?? 0);
        const failed = Number(failedCountRes ?? 0);
        const pending = Number(pendingCountRes ?? 0);

        if (passedJobId) {
          await upsertJob({
            id: passedJobId,
            status: 'RUNNING',
            processed: sent + failed,
            total: Math.max(sent + failed + pending, 1),
            meta: {
              stage: 'sending',
              sent,
              failed,
              pending,
              lastEmail: to,
            },
          });
        }

        await db.from('Campaign').update({ sentCount: sent, failedCount: failed, status: 'SENDING' }).eq('id', campaignId);
        return jsonResponse({ success: false, error: message, jobId: passedJobId || null }, 400);
      }
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('[send-campaign-email]', message);
    return jsonResponse({ error: message }, 500);
  }
});
