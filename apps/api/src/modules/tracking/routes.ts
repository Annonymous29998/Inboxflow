import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { enqueueBounce } from '../../services/email/queue.js';
import {
  isSafeRedirectUrl,
  verifyClickRedirect,
  verifyUnsubscribe,
} from '../../utils/signed-urls.js';

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

function parseUa(ua: string | undefined) {
  const u = (ua || '').toLowerCase();
  let device = 'desktop';
  if (/mobile|android|iphone/.test(u)) device = 'mobile';
  else if (/ipad|tablet/.test(u)) device = 'tablet';

  let emailClient = 'unknown';
  if (u.includes('googleimageproxy') || u.includes('gmail')) emailClient = 'gmail';
  else if (u.includes('outlook') || u.includes('microsoft')) emailClient = 'outlook';
  else if (u.includes('applewebkit') && u.includes('mail')) emailClient = 'apple_mail';
  else if (u.includes('thunderbird')) emailClient = 'thunderbird';
  else if (u.includes('yahoo')) emailClient = 'yahoo';

  let os = 'unknown';
  if (u.includes('windows')) os = 'windows';
  else if (u.includes('mac os') || u.includes('macintosh')) os = 'macos';
  else if (u.includes('android')) os = 'android';
  else if (u.includes('iphone') || u.includes('ipad')) os = 'ios';
  else if (u.includes('linux')) os = 'linux';

  let browser = 'unknown';
  if (u.includes('chrome')) browser = 'chrome';
  else if (u.includes('safari')) browser = 'safari';
  else if (u.includes('firefox')) browser = 'firefox';
  else if (u.includes('edg')) browser = 'edge';

  return { device, emailClient, os, browser };
}

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

export async function trackingRoutes(app: FastifyInstance) {
  // Open pixel
  app.get('/o/:campaignId/:contactId.gif', async (request, reply) => {
    const { campaignId, contactId } = request.params as { campaignId: string; contactId: string };
    const ua = parseUa(request.headers['user-agent']);

    const contactIdClean = contactId.replace(/\.gif$/, '');

    try {
      const existing = await prisma.trackingEvent.findFirst({
        where: { campaignId, contactId: contactIdClean, type: 'OPENED' },
      });

      await prisma.trackingEvent.create({
        data: {
          type: 'OPENED',
          campaignId,
          contactId: contactIdClean,
          userAgent: request.headers['user-agent'],
          ipAddress: request.ip,
          ...ua,
        },
      });

      if (!existing) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { openedCount: { increment: 1 } },
        });
        await prisma.campaignRecipient.updateMany({
          where: { campaignId, contactId: contactIdClean, openedAt: null },
          data: { openedAt: new Date(), status: 'OPENED' },
        });
      }
    } catch (e) {
      console.error('Open tracking error', e);
    }

    reply.header('Content-Type', 'image/gif');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return reply.send(TRANSPARENT_GIF);
  });

  // Click redirect — requires HMAC signature; blocks open redirects
  app.get('/c/:campaignId/:contactId', async (request, reply) => {
    const { campaignId, contactId } = request.params as { campaignId: string; contactId: string };
    const q = request.query as { u?: string; s?: string };
    const url = q.u || '';

    if (!url || !isSafeRedirectUrl(url) || !verifyClickRedirect(campaignId, contactId, url, q.s)) {
      return reply.status(400).type('text/plain').send('Invalid or unsigned tracking link');
    }

    const ua = parseUa(request.headers['user-agent']);

    try {
      await prisma.trackingEvent.create({
        data: {
          type: 'CLICKED',
          campaignId,
          contactId,
          url,
          userAgent: request.headers['user-agent'],
          ipAddress: request.ip,
          ...ua,
        },
      });
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { clickedCount: { increment: 1 } },
      });
      await prisma.campaignRecipient.updateMany({
        where: { campaignId, contactId },
        data: { clickedAt: new Date(), status: 'CLICKED' },
      });
    } catch (e) {
      console.error('Click tracking error', e);
    }

    return reply.redirect(url);
  });

  // One-click unsubscribe — requires HMAC signature
  app.route({
    method: ['GET', 'POST'],
    url: '/unsubscribe',
    handler: async (request, reply) => {
      const q = { ...(request.query as object), ...(request.body as object) } as {
        c?: string;
        e?: string;
        cid?: string;
        s?: string;
      };

      if (!q.c || !verifyUnsubscribe(q.c, q.cid, q.s)) {
        return reply.status(400).type('text/html').send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
          <h1>Invalid unsubscribe link</h1>
          <p>This link is missing a valid signature and cannot be used.</p>
        </body></html>`);
      }

      try {
        const contact = await prisma.contact.findUnique({ where: { id: q.c } });
        if (contact && contact.status === 'SUBSCRIBED') {
          await prisma.contact.update({
            where: { id: contact.id },
            data: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() },
          });
          await prisma.suppressionList.upsert({
            where: {
              organizationId_email: {
                organizationId: contact.organizationId,
                email: contact.email,
              },
            },
            create: {
              organizationId: contact.organizationId,
              email: contact.email,
              reason: 'unsubscribe',
              source: 'one_click',
            },
            update: { reason: 'unsubscribe' },
          });
          if (q.cid) {
            await prisma.campaign.update({
              where: { id: q.cid },
              data: { unsubscribedCount: { increment: 1 } },
            });
            await prisma.trackingEvent.create({
              data: { type: 'UNSUBSCRIBED', campaignId: q.cid, contactId: contact.id },
            });
          }
        }
      } catch (e) {
        console.error('Unsubscribe error', e);
      }

      return reply.type('text/html').send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1>You have been unsubscribed</h1>
        <p>You will no longer receive marketing emails from this sender.</p>
      </body></html>`);
    },
  });
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/:provider', async (request, reply) => {
    if (!webhookAuthorized(request)) {
      return reply.status(401).send({ error: 'Unauthorized webhook' });
    }

    const { provider } = request.params as { provider: string };
    const body = request.body as Record<string, unknown>;
    const orgId = (request.query as { org?: string }).org || '';

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing org query parameter' });
    }

    try {
      if (provider === 'ses') {
        const msg = typeof body.Message === 'string' ? JSON.parse(body.Message) : body;
        const notificationType = (msg as { notificationType?: string }).notificationType;
        if (notificationType === 'Bounce') {
          const bounce = (
            msg as {
              bounce?: {
                bounceType?: string;
                bouncedRecipients?: Array<{ emailAddress: string }>;
              };
            }
          ).bounce;
          for (const r of bounce?.bouncedRecipients || []) {
            await enqueueBounce({
              email: r.emailAddress,
              type: bounce?.bounceType === 'Permanent' ? 'HARD' : 'SOFT',
              organizationId: orgId,
            });
          }
        }
      }

      if (provider === 'sendgrid') {
        const events = Array.isArray(body) ? body : [body];
        for (const ev of events as Array<{ event?: string; email?: string }>) {
          if (ev.event === 'bounce' || ev.event === 'dropped') {
            if (!ev.email) continue;
            await enqueueBounce({
              email: ev.email,
              type: ev.event === 'bounce' ? 'HARD' : 'SOFT',
              organizationId: orgId,
            });
          }
        }
      }
    } catch (e) {
      console.error('Webhook processing error', e);
    }

    return reply.send({ received: true });
  });
}
