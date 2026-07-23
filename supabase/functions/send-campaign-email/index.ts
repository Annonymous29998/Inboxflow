import { corsHeaders, jsonResponse } from '../_shared/cors.ts';
import { getServiceClient, requireOrg, verifyInboxFlowJwt } from '../_shared/auth.ts';
import { invokeBackgroundWorker } from '../_shared/background-worker.ts';
import {
  buildTrackBaseUrl,
  signClickRedirect,
} from '../_shared/signed-urls.ts';
import { resolveSmtpProvider, sendViaSmtp } from '../_shared/smtp.ts';
import { buildDeliverabilityHeaders, htmlToPlainText, stripAppUnsubscribeTokens, validateCampaignContent } from '../_shared/deliverability.ts';

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

    if (action === 'prepare') {
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
          totalRecipients: contacts.length,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
        })
        .eq('id', campaignId);

      return jsonResponse({ success: true, recipients });
    }

    if (action === 'background-start') {
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
          totalRecipients: contacts.length,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
          ...(queueSettings ? { queueSettings } : {}),
        })
        .eq('id', campaignId);

      await invokeBackgroundWorker(campaignId);

      return jsonResponse({
        success: true,
        background: true,
        totalRecipients: contacts.length,
        status: 'SENDING',
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
        .select('status, totalRecipients, sentCount, completedAt')
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

      const sent = sentCount ?? 0;
      const failed = failedCount ?? 0;
      const pending = pendingCount ?? 0;

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
          completedAt: status === 'SENT' || status === 'CANCELLED' ? new Date().toISOString() : null,
        })
        .eq('id', campaignId);

      return jsonResponse({ success: true, sentCount: sent, failedCount: failed, pendingCount: pending, status });
    }

    if (action === 'send-one') {
      const recipientId = String(body.recipientId ?? '').trim();
      if (!recipientId) {
        return jsonResponse({ error: 'recipientId is required' }, 400);
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
        return jsonResponse({ success: false, error: 'Contact not subscribed' }, 400);
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
        campaign.senderEmail ||
        smtp.fromEmail ||
        smtp.user ||
        `noreply@${domainName || 'localhost'}`;
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
        }).eq('id', recipientId);

        const { data: currentCampaign } = await db
          .from('Campaign')
          .select('sentCount')
          .eq('id', campaignId)
          .maybeSingle();

        await db.from('Campaign').update({
          sentCount: Number(currentCampaign?.sentCount ?? 0) + 1,
        }).eq('id', campaignId);

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

        return jsonResponse({ success: true, messageId: result.messageId });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Send failed';
        await db.from('CampaignRecipient').update({ status: 'FAILED', error: message }).eq('id', recipientId);
        return jsonResponse({ success: false, error: message }, 400);
      }
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal error';
    console.error('[send-campaign-email]', message);
    return jsonResponse({ error: message }, 500);
  }
});
