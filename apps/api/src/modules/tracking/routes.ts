import type { FastifyInstance } from 'fastify';
import { prisma } from '../../config/prisma.js';
import {
  isSafeRedirectUrl,
  verifyClickRedirect,
  verifyUnsubscribe,
} from '../../utils/signed-urls.js';
import { classifyAutomatedTracking, isCountableClick, isCountableOpen } from '../../utils/tracking-bot-filter.js';

export { webhookRoutes } from './webhook-routes.js';

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

export async function trackingRoutes(app: FastifyInstance) {
  // Open pixel
  app.get('/o/:campaignId/:contactId.gif', async (request, reply) => {
    const { campaignId, contactId } = request.params as { campaignId: string; contactId: string };
    const rawUa = String(request.headers['user-agent'] || '');
    const ua = parseUa(rawUa);
    const auto = classifyAutomatedTracking(rawUa);

    const contactIdClean = contactId.replace(/\.gif$/, '');

    try {
      const countable = isCountableOpen(rawUa, undefined);
      const metadata = countable
        ? undefined
        : { source: 'automated', reason: auto.reason ?? 'non_mail_client' };

      const priorOpens = await prisma.trackingEvent.findMany({
        where: { campaignId, contactId: contactIdClean, type: 'OPENED' },
        select: { userAgent: true, metadata: true },
      });
      const existingCountable = priorOpens.some((e) => isCountableOpen(e.userAgent, e.metadata));

      await prisma.trackingEvent.create({
        data: {
          type: 'OPENED',
          campaignId,
          contactId: contactIdClean,
          userAgent: rawUa,
          ipAddress: request.ip,
          metadata,
          ...ua,
        },
      });

      if (countable && !existingCountable) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { openedCount: { increment: 1 } },
        });
        const updated = await prisma.campaignRecipient.updateMany({
          where: { campaignId, contactId: contactIdClean, openedAt: null },
          data: { openedAt: new Date(), status: 'OPENED' },
        });
        // Engagement implies inbox delivery — promote SENT → delivered without waiting for ESP webhook.
        if (updated.count > 0) {
          const promoted = await prisma.campaignRecipient.updateMany({
            where: {
              campaignId,
              contactId: contactIdClean,
              deliveredAt: null,
              status: { in: ['OPENED', 'SENT', 'DELIVERED'] },
            },
            data: { deliveredAt: new Date() },
          });
          if (promoted.count > 0) {
            await prisma.campaign.update({
              where: { id: campaignId },
              data: { deliveredCount: { increment: promoted.count } },
            });
          }
        }
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

    const rawUa = String(request.headers['user-agent'] || '');
    const ua = parseUa(rawUa);
    const auto = classifyAutomatedTracking(rawUa);

    try {
      const priorOpens = await prisma.trackingEvent.findMany({
        where: { campaignId, contactId, type: 'OPENED' },
        select: { userAgent: true, metadata: true },
      });
      const hasVerifiedOpen = priorOpens.some((e) => isCountableOpen(e.userAgent, e.metadata));
      const countable = isCountableClick(rawUa, undefined, hasVerifiedOpen);

      const metadata = countable
        ? undefined
        : {
            source: 'automated',
            reason: hasVerifiedOpen
              ? (auto.reason ?? 'non_mail_client')
              : 'no_verified_open',
          };

      const priorClicks = await prisma.trackingEvent.findMany({
        where: { campaignId, contactId, type: 'CLICKED' },
        select: { userAgent: true, metadata: true },
      });
      const existingCountable = priorClicks.some(
        (e) => isCountableClick(e.userAgent, e.metadata, hasVerifiedOpen),
      );

      await prisma.trackingEvent.create({
        data: {
          type: 'CLICKED',
          campaignId,
          contactId,
          url,
          userAgent: rawUa,
          ipAddress: request.ip,
          metadata,
          ...ua,
        },
      });

      if (countable && !existingCountable) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { clickedCount: { increment: 1 } },
        });
      }

      if (countable) {
        await prisma.campaignRecipient.updateMany({
          where: { campaignId, contactId },
          data: { clickedAt: new Date(), status: 'CLICKED' },
        });
      }
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
