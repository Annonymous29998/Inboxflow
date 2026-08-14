import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { env } from '../../config/env.js';
import { enqueueBounce } from '../../services/email/queue.js';
import {
  markRecipientDelivered,
  parseBrevoCustom,
} from '../../services/email/delivery-events.js';

function webhookAuthorized(request: {
  headers: Record<string, unknown>;
  query: unknown;
}): boolean {
  const expected = env.WEBHOOK_SECRET;
  if (!expected) {
    // Refuse unsigned webhooks outside explicit local-dev without a secret
    return env.NODE_ENV !== 'production';
  }
  const header =
    (request.headers['x-webhook-secret'] as string | undefined) ||
    (request.headers['x-api-key'] as string | undefined) ||
    '';
  const querySecret = (request.query as { secret?: string }).secret || '';
  const provided = header || querySecret;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function normalizeEvent(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

type BounceEnqueue = {
  email: string;
  type: 'HARD' | 'SOFT';
  organizationId: string;
  campaignId?: string;
  recipientId?: string;
  contactId?: string;
  messageId?: string;
  reason?: string;
};

async function enqueueHardOrSoft(data: BounceEnqueue) {
  await enqueueBounce(data);
}

/**
 * ESP delivery webhooks (Brevo / SES / SendGrid / Mailgun / Postmark).
 * URL shape: POST /api/webhooks/:provider?org=<organizationId>&secret=<WEBHOOK_SECRET>
 * Or header: X-Webhook-Secret / X-Api-Key
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.post('/:provider', async (request, reply) => {
    if (!webhookAuthorized(request)) {
      return reply.status(401).send({ error: 'Unauthorized webhook' });
    }

    const { provider } = request.params as { provider: string };
    const body = request.body as Record<string, unknown> | unknown[];
    const orgId = (request.query as { org?: string }).org || '';

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing org query parameter' });
    }

    const providerKey = provider.toLowerCase();

    try {
      if (providerKey === 'ses') {
        const raw = body as Record<string, unknown>;
        const msg = typeof raw.Message === 'string' ? JSON.parse(raw.Message) : raw;
        const notificationType = (msg as { notificationType?: string }).notificationType;
        if (notificationType === 'Bounce') {
          const bounce = (
            msg as {
              bounce?: {
                bounceType?: string;
                bouncedRecipients?: Array<{ emailAddress: string; diagnosticCode?: string }>;
              };
              mail?: { messageId?: string; headers?: Array<{ name?: string; value?: string }> };
            }
          ).bounce;
          const mail = (
            msg as {
              mail?: { messageId?: string; headers?: Array<{ name?: string; value?: string }> };
            }
          ).mail;
          const headers = Object.fromEntries(
            (mail?.headers || [])
              .filter((h) => h.name && h.value)
              .map((h) => [String(h.name).toLowerCase(), String(h.value)]),
          );
          for (const r of bounce?.bouncedRecipients || []) {
            await enqueueHardOrSoft({
              email: r.emailAddress,
              type: bounce?.bounceType === 'Permanent' ? 'HARD' : 'SOFT',
              organizationId: orgId,
              campaignId: headers['x-if-campaign-id'],
              recipientId: headers['x-if-recipient-id'],
              contactId: headers['x-if-contact-id'],
              messageId: mail?.messageId,
              reason: r.diagnosticCode || bounce?.bounceType,
            });
          }
        } else if (notificationType === 'Delivery') {
          const mail = (
            msg as {
              mail?: {
                messageId?: string;
                destination?: string[];
                headers?: Array<{ name?: string; value?: string }>;
              };
            }
          ).mail;
          const headers = Object.fromEntries(
            (mail?.headers || [])
              .filter((h) => h.name && h.value)
              .map((h) => [String(h.name).toLowerCase(), String(h.value)]),
          );
          for (const email of mail?.destination || []) {
            await markRecipientDelivered({
              organizationId: orgId,
              email,
              campaignId: headers['x-if-campaign-id'],
              recipientId: headers['x-if-recipient-id'],
              contactId: headers['x-if-contact-id'],
              messageId: mail?.messageId,
            });
          }
        }
      }

      if (providerKey === 'sendgrid') {
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events as Array<{
          event?: string;
          email?: string;
          reason?: string;
          type?: string;
          sg_message_id?: string;
          campaignId?: string;
          recipientId?: string;
          contactId?: string;
        }>) {
          const event = normalizeEvent(ev.event);
          if (!ev.email) continue;
          if (event === 'bounce' || event === 'dropped' || event === 'blocked') {
            await enqueueHardOrSoft({
              email: ev.email,
              type: event === 'dropped' || event === 'blocked' ? 'HARD' : 'HARD',
              organizationId: orgId,
              campaignId: typeof ev.campaignId === 'string' ? ev.campaignId : undefined,
              recipientId: typeof ev.recipientId === 'string' ? ev.recipientId : undefined,
              contactId: typeof ev.contactId === 'string' ? ev.contactId : undefined,
              messageId: ev.sg_message_id,
              reason: ev.reason || event,
            });
          } else if (event === 'delivered') {
            await markRecipientDelivered({
              organizationId: orgId,
              email: ev.email,
              campaignId: typeof ev.campaignId === 'string' ? ev.campaignId : undefined,
              recipientId: typeof ev.recipientId === 'string' ? ev.recipientId : undefined,
              contactId: typeof ev.contactId === 'string' ? ev.contactId : undefined,
              messageId: ev.sg_message_id,
            });
          }
        }
      }

      if (providerKey === 'brevo' || providerKey === 'sendinblue') {
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events as Array<Record<string, unknown>>) {
          const event = normalizeEvent(ev.event ?? ev.msg_status ?? ev.bounce_type);
          const email = String(ev.email || '').trim();
          if (!email && event !== 'delivered') continue;

          const custom = parseBrevoCustom(ev['X-Mailin-custom'] ?? ev['x-mailin-custom'] ?? ev.custom);
          const messageId = String(ev['message-id'] || ev.messageId || '').trim() || undefined;
          const reason = String(ev.reason || ev.msg_status || event || '').slice(0, 500) || undefined;

          const hardEvents = new Set([
            'hard_bounce',
            'hardbounce',
            'blocked',
            'invalid',
            'invalid_email',
            'error',
            'spam',
          ]);
          const softEvents = new Set(['soft_bounce', 'softbounce', 'deferred']);

          if (hardEvents.has(event) || softEvents.has(event)) {
            await enqueueHardOrSoft({
              email,
              type: hardEvents.has(event) ? 'HARD' : 'SOFT',
              organizationId: orgId,
              campaignId: custom.campaignId,
              recipientId: custom.recipientId,
              contactId: custom.contactId,
              messageId,
              reason,
            });
          } else if (event === 'delivered') {
            await markRecipientDelivered({
              organizationId: orgId,
              email: email || undefined,
              campaignId: custom.campaignId,
              recipientId: custom.recipientId,
              contactId: custom.contactId,
              messageId,
            });
          }
        }
      }

      if (providerKey === 'mailgun') {
        const ev = (body as { event?: string; 'event-data'?: Record<string, unknown> })['event-data']
          || (body as Record<string, unknown>);
        const event = normalizeEvent(ev.event || (body as { event?: string }).event);
        const email = String(
          (ev.recipient as string) ||
            ((ev.message as { headers?: { to?: string } })?.headers?.to) ||
            '',
        ).trim();
        const userVars = (ev['user-variables'] || {}) as Record<string, string>;
        if (email && (event === 'failed' || event === 'rejected' || event === 'bounced')) {
          const severity = String(ev.severity || '').toLowerCase();
          await enqueueHardOrSoft({
            email,
            type: severity === 'temporary' ? 'SOFT' : 'HARD',
            organizationId: orgId,
            campaignId: userVars.campaignId,
            recipientId: userVars.recipientId,
            contactId: userVars.contactId,
            messageId: String((ev.message as { headers?: { 'message-id'?: string } })?.headers?.['message-id'] || '') || undefined,
            reason: String((ev['delivery-status'] as { message?: string })?.message || event),
          });
        } else if (email && event === 'delivered') {
          await markRecipientDelivered({
            organizationId: orgId,
            email,
            campaignId: userVars.campaignId,
            recipientId: userVars.recipientId,
            contactId: userVars.contactId,
          });
        }
      }

      if (providerKey === 'postmark') {
        const ev = body as {
          RecordType?: string;
          Type?: string;
          Email?: string;
          Recipient?: string;
          MessageID?: string;
          Description?: string;
          Details?: string;
          Metadata?: Record<string, string>;
        };
        const record = String(ev.RecordType || '').toLowerCase();
        const email = String(ev.Email || ev.Recipient || '').trim();
        const meta = ev.Metadata || {};
        if (email && (record === 'bounce' || record === 'spamcomplaint')) {
          const bounceType = String(ev.Type || '').toLowerCase();
          await enqueueHardOrSoft({
            email,
            type: bounceType.includes('transient') || bounceType.includes('soft') ? 'SOFT' : 'HARD',
            organizationId: orgId,
            campaignId: meta.campaignId,
            recipientId: meta.recipientId,
            contactId: meta.contactId,
            messageId: ev.MessageID,
            reason: ev.Description || ev.Details || ev.Type,
          });
        } else if (email && record === 'delivery') {
          await markRecipientDelivered({
            organizationId: orgId,
            email,
            campaignId: meta.campaignId,
            recipientId: meta.recipientId,
            contactId: meta.contactId,
            messageId: ev.MessageID,
          });
        }
      }
    } catch (e) {
      console.error('Webhook processing error', e);
    }

    return reply.send({ received: true });
  });
}
