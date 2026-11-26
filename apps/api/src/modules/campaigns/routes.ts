import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { Prisma } from '@prisma/client';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { requireOrg } from '../../utils/org.js';
import {
  drainCampaignJobs,
  enqueueCampaign,
  enqueueCampaignScheduled,
  resetCampaignForResend,
} from '../../services/email/queue.js';
import { sendCampaignEmailToRecipient, sendPlacementMessage } from '../../services/email/campaign-send.js';
import { analyzeCampaign } from '../deliverability/analyzer.js';
import { scrubCampaignContent, findRemainingSpamPhrases, hardenOutboundMime, stripHtmlTags } from '../deliverability/spam-scrubber.js';
import { ensureCampaignSendJob, upsertJobProgress } from '../jobs/progress.js';
import { writeSystemLog } from '../../services/system-log.js';
import { deliveredRecipientFilter, normalizeSentFailed } from './recipient-stats.js';
import { campaignListPagePlan } from './campaign-list-order.js';
import { buildCampaignSendStatus } from './send-status-builder.js';
import { recountCampaignEngagement } from '../../services/tracking/recount.js';
import { getCampaignsListStats } from '../../services/campaigns/live-stats.js';
import { maybeFinalizeCampaignSend } from '../../services/email/campaign-finalize.js';
import { normalizeBatchSize, withRecommendedPacing } from '../../services/email/queue-settings.js';
import { emailDomain, parseSmtpFromIdentities } from '../../services/email/mail-headers.js';
import { guardRecipientAddress, prefetchMxForDomains } from '../../services/email/recipient-guard.js';
import { removeContactsFromAudience } from '../contacts/audience-cleanup.js';

const RESEND_NAME_SUFFIX = /\s·\sresend(?:\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2})?$/i;

function campaignBaseName(name?: string | null) {
  return (name || 'Campaign').replace(RESEND_NAME_SUFFIX, '').trim() || 'Campaign';
}

async function nextResendName(organizationId: string, sourceName?: string | null) {
  const base = campaignBaseName(sourceName);
  const simple = `${base} · resend`;
  const clash = await prisma.campaign.findFirst({
    where: { organizationId, name: simple },
    select: { id: true },
  });
  if (!clash) return simple;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `${base} · resend ${stamp}`;
}

async function domainIdForSender(organizationId: string, email?: string | null) {
  const d = emailDomain(String(email || ''));
  if (!d) return null;
  const rows = await prisma.domain.findMany({
    where: { organizationId, status: 'VERIFIED' },
    select: { id: true, domain: true },
  });
  return rows.find((r) => d === r.domain || d.endsWith(`.${r.domain}`))?.id ?? null;
}

type SegmentRules = {
  conditions?: Array<{ field: string; operator: string; value: string }>;
  match?: 'all' | 'any';
};

/** Queue console: active first, then newest send — without relying on updatedAt recount bumps. */
function sortQueueCampaignRows<
  T extends { status: string; sentAt?: Date | string | null; createdAt?: Date | string | null; updatedAt?: Date | string | null },
>(rows: T[]): T[] {
  const rank = (s: string) => {
    if (s === 'SENDING') return 0;
    if (s === 'PAUSED') return 1;
    if (s === 'READY' || s === 'SCHEDULED') return 2;
    return 3;
  };
  const ts = (v?: Date | string | null) => {
    if (!v) return 0;
    const n = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(n) ? n : 0;
  };
  return [...rows].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status);
    if (byStatus !== 0) return byStatus;
    const bySent = ts(b.sentAt) - ts(a.sentAt);
    if (bySent !== 0) return bySent;
    return ts(b.createdAt) - ts(a.createdAt) || ts(b.updatedAt) - ts(a.updatedAt);
  });
}

async function resolveSegmentContacts(organizationId: string, rules: SegmentRules) {
  const contacts = await prisma.contact.findMany({
    where: { organizationId, status: 'SUBSCRIBED' },
  });

  if (!rules.conditions?.length) return contacts;

  return contacts.filter((c) => {
    const checks = rules.conditions!.map((cond) => {
      const val = String(
        cond.field === 'email'
          ? c.email
          : cond.field === 'firstName'
            ? c.firstName
            : cond.field === 'lastName'
              ? c.lastName
              : ((c.customData as Record<string, string>)?.[cond.field] ?? ''),
      ).toLowerCase();
      const target = cond.value.toLowerCase();
      switch (cond.operator) {
        case 'equals':
          return val === target;
        case 'contains':
          return val.includes(target);
        case 'starts_with':
          return val.startsWith(target);
        default:
          return false;
      }
    });
    return rules.match === 'any' ? checks.some(Boolean) : checks.every(Boolean);
  });
}

async function loadAudienceContacts(campaign: {
  organizationId: string;
  listId: string | null;
  segmentId: string | null;
}) {
  let contacts: Array<{
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    status: string;
  }> = [];

  if (campaign.listId) {
    const list = await prisma.contactList.findFirst({
      where: { id: campaign.listId, organizationId: campaign.organizationId },
      include: { members: { include: { contact: true } } },
    });
    contacts =
      list?.members.map((m) => m.contact).filter((c) => c.status === 'SUBSCRIBED') ?? [];
  }

  if (campaign.segmentId) {
    const segment = await prisma.segment.findUnique({ where: { id: campaign.segmentId } });
    if (segment) {
      contacts = await resolveSegmentContacts(
        campaign.organizationId,
        segment.rules as SegmentRules,
      );
    }
  }

  const suppressed = await prisma.suppressionList.findMany({
    where: {
      organizationId: campaign.organizationId,
      email: { in: contacts.map((c) => c.email) },
    },
    select: { email: true },
  });
  const suppressedSet = new Set(suppressed.map((s) => s.email.toLowerCase()));
  return contacts.filter((c) => !suppressedSet.has(c.email.toLowerCase()));
}

async function inspectCampaignAudience(campaign: {
  organizationId: string;
  listId: string | null;
  segmentId: string | null;
}) {
  const raw = await loadAudienceContacts(campaign);
  const domains = [...new Set(raw.map((c) => emailDomain(c.email)).filter(Boolean))];
  await prefetchMxForDomains(domains);
  const skipped: Array<{ email: string; reason: string; code: string }> = [];
  const ok: typeof raw = [];
  for (const c of raw) {
    const g = await guardRecipientAddress(c.email);
    if (g.ok) ok.push(c);
    else skipped.push({ email: c.email, reason: g.reason, code: g.code });
  }
  return { ok, skipped, total: raw.length };
}

async function collectCampaignContacts(campaign: {
  organizationId: string;
  listId: string | null;
  segmentId: string | null;
}) {
  return (await inspectCampaignAudience(campaign)).ok;
}

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const q = request.query as { status?: string; page?: string; limit?: string };
      const page = Number(q.page || 1);
      const limit = Math.min(Number(q.limit || 20), 100);
      const where: Record<string, unknown> = { organizationId: orgId };
      if (q.status) where.status = q.status;

      const listSelect = {
        id: true,
        name: true,
        status: true,
        type: true,
        subject: true,
        deliverabilityScore: true,
        sentCount: true,
        deliveredCount: true,
        failedCount: true,
        openedCount: true,
        clickedCount: true,
        utmCampaign: true,
        bouncedCount: true,
        totalRecipients: true,
        sentAt: true,
        updatedAt: true,
        list: { select: { id: true, name: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
      } as const;
      const draftWhere = { ...where, sentAt: null };
      const sentWhere = { ...where, sentAt: { not: null } };
      const [draftCount, sentCount] = await Promise.all([
        prisma.campaign.count({ where: draftWhere }),
        prisma.campaign.count({ where: sentWhere }),
      ]);
      const total = draftCount + sentCount;
      const plan = campaignListPagePlan(draftCount, page, limit);
      const [draftRows, sentRows] = await Promise.all([
        plan.draftTake
          ? prisma.campaign.findMany({
              where: draftWhere,
              orderBy: { createdAt: 'desc' },
              skip: plan.draftSkip,
              take: plan.draftTake,
              select: listSelect,
            })
          : Promise.resolve([]),
        plan.sentTake
          ? prisma.campaign.findMany({
              where: sentWhere,
              // Last send time — not updatedAt — so open/click recounts don't reshuffle.
              orderBy: { sentAt: 'desc' },
              skip: plan.sentSkip,
              take: plan.sentTake,
              select: listSelect,
            })
          : Promise.resolve([]),
      ]);
      const campaigns = [...draftRows, ...sentRows];

      const sendingIds = campaigns.filter((c) => c.status === 'SENDING').map((c) => c.id);
      if (sendingIds.length) {
        await Promise.all(sendingIds.map((id) => maybeFinalizeCampaignSend(id)));
      }
      const flipped = sendingIds.length
        ? await prisma.campaign.findMany({
            where: { id: { in: sendingIds } },
            select: { id: true, status: true },
          })
        : [];
      const flippedById = new Map(flipped.map((c) => [c.id, c.status]));

      const liveIds = campaigns
        .filter((c) => ['SENT', 'SENDING', 'PAUSED', 'CANCELLED', 'FAILED'].includes(c.status))
        .map((c) => c.id);
      const liveById = await getCampaignsListStats(liveIds);

      const enriched = campaigns.map((c) => {
        const live = liveById.get(c.id);
        const status = flippedById.get(c.id) ?? c.status;
        if (!live) {
          if (status === c.status) return c;
          return { ...c, status };
        }
        const counts = normalizeSentFailed(live.sentCount, live.failedCount, c.totalRecipients);
        return {
          ...c,
          status,
          sentCount: counts.sent,
          deliveredCount: counts.sent,
          failedCount: counts.failed,
          pendingCount: live.pendingCount,
          bouncedCount: live.bouncedCount || c.bouncedCount,
          openedCount: live.openedCount,
          clickedCount: live.clickedCount,
        };
      });

      return reply.send({ campaigns: enriched, total, page, limit });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const emptyToUndef = (v: unknown) => (v === '' || v === null || v === undefined ? undefined : v);
      const optionalEmail = z.preprocess(
        emptyToUndef,
        z.string().email().optional(),
      );

      const body = z
        .object({
          name: z.string().optional().default(''),
          type: z.enum(['REGULAR', 'SCHEDULED', 'AUTOMATED', 'DRIP']).default('REGULAR'),
          subject: z.preprocess(emptyToUndef, z.string().optional()),
          previewText: z.preprocess(emptyToUndef, z.string().optional()),
          senderName: z.preprocess(emptyToUndef, z.string().optional()),
          senderEmail: optionalEmail,
          replyTo: optionalEmail,
          listId: z.preprocess(emptyToUndef, z.string().optional()),
          segmentId: z.preprocess(emptyToUndef, z.string().optional()),
          templateId: z.preprocess(emptyToUndef, z.string().optional()),
          providerId: z.preprocess(emptyToUndef, z.string().optional()),
          trackOpens: z.boolean().default(true),
          trackClicks: z.boolean().default(true),
          utmSource: z.string().optional(),
          utmMedium: z.string().optional(),
          utmCampaign: z.string().optional(),
          htmlContent: z.string().optional().nullable(),
          plainTextContent: z.string().optional().nullable(),
          editorJson: z.unknown().optional(),
          status: z.enum(['DRAFT', 'READY', 'SCHEDULED']).default('DRAFT'),
        })
        .parse(request.body);

      // Prefer loading HTML from the saved template so large imports don't need a huge request body
      let htmlContent = body.htmlContent || null;
      let plainTextContent = body.plainTextContent || null;
      let editorJson = body.editorJson as object | undefined;
      const resolvedName = String(body.name || '').trim();
      let templateId = body.templateId;

      if (templateId) {
        const template = await prisma.template.findFirst({
          where: { id: templateId, OR: [{ organizationId: orgId }, { isPublic: true }] },
        });
        if (!template) throw new AppError(404, 'Template not found');
        if (!htmlContent?.trim() && template.htmlContent?.trim()) {
          htmlContent = template.htmlContent;
          plainTextContent = plainTextContent || template.plainText || null;
          if (!editorJson && template.editorJson) {
            editorJson = template.editorJson as object;
          } else if (!editorJson && htmlContent) {
            editorJson = {
              blocks: [{ id: `html-${Date.now()}`, type: 'html', content: htmlContent }],
            };
          }
        }
      }

      const scrubbed = scrubCampaignContent({
        subject: body.subject,
        previewText: body.previewText,
        htmlContent,
        plainTextContent,
      });

      const linkedDomainId = await domainIdForSender(orgId, body.senderEmail || null);

      const campaign = await prisma.campaign.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: resolvedName,
          type: body.type,
          status: body.status,
          subject: scrubbed.subject || null,
          previewText: scrubbed.previewText || null,
          senderName: body.senderName || null,
          senderEmail: body.senderEmail || null,
          domainId: linkedDomainId,
          replyTo: body.replyTo || null,
          listId: body.listId || null,
          segmentId: body.segmentId || null,
          templateId: templateId || null,
          providerId: body.providerId || null,
          trackOpens: body.trackOpens,
          trackClicks: body.trackClicks,
          utmSource: body.utmSource,
          utmMedium: body.utmMedium,
          utmCampaign: body.utmCampaign,
          htmlContent: scrubbed.htmlContent || null,
          plainTextContent: scrubbed.plainTextContent || null,
          editorJson: editorJson ?? undefined,
          queueSettings: withRecommendedPacing({}) as object,
        },
      });

      return reply.status(201).send({ campaign, scrubbed: scrubbed.changed, removed: scrubbed.removed });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/queue-console', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const campaigns = await prisma.campaign.findMany({
        where: {
          organizationId: orgId,
          status: { in: ['SENDING', 'PAUSED', 'READY', 'SCHEDULED', 'CANCELLED', 'SENT', 'FAILED'] },
        },
        orderBy: [
          { sentAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        take: 40,
        select: {
          id: true,
          name: true,
          status: true,
          subject: true,
          sentCount: true,
          openedCount: true,
          clickedCount: true,
          totalRecipients: true,
          sentAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
          queueSettings: true,
        },
      });

      const allIds = campaigns.map((c) => c.id);
      const liveById = await getCampaignsListStats(allIds);

      const rows = sortQueueCampaignRows(
        campaigns.map((c) => {
          const live = liveById.get(c.id);
          const pending = live?.pendingCount ?? 0;
          const sent = live?.sentCount ?? c.sentCount ?? 0;
          const failed = live?.failedCount ?? 0;
          return {
            ...c,
            queueSettings: withRecommendedPacing(c.queueSettings),
            pending,
            sent,
            failed,
            opened: live?.openedCount ?? c.openedCount ?? 0,
            clicked: live?.clickedCount ?? c.clickedCount ?? 0,
            total: c.totalRecipients || pending + sent + failed,
          };
        }),
      );

      return reply.send({ campaigns: rows });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/import-config', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          campaign: z.object({
            name: z.string().min(1),
            subject: z.string().optional().nullable(),
            previewText: z.string().optional().nullable(),
            senderName: z.string().optional().nullable(),
            senderEmail: z.string().optional().nullable(),
            replyTo: z.string().optional().nullable(),
            htmlContent: z.string().optional().nullable(),
            plainTextContent: z.string().optional().nullable(),
            trackOpens: z.boolean().optional(),
            trackClicks: z.boolean().optional(),
            queueSettings: z.unknown().optional().nullable(),
            subjectPool: z.array(z.string()).optional().nullable(),
            fromNamePool: z.array(z.string()).optional().nullable(),
            utmSource: z.string().optional().nullable(),
            utmMedium: z.string().optional().nullable(),
            utmCampaign: z.string().optional().nullable(),
          }),
        })
        .parse(request.body);

      const c = body.campaign;
      const campaign = await prisma.campaign.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: `${c.name} (import)`,
          status: 'DRAFT',
          subject: c.subject,
          previewText: c.previewText,
          senderName: c.senderName,
          senderEmail: c.senderEmail,
          replyTo: c.replyTo,
          htmlContent: c.htmlContent,
          plainTextContent: c.plainTextContent,
          trackOpens: c.trackOpens ?? true,
          trackClicks: c.trackClicks ?? true,
          queueSettings: withRecommendedPacing(c.queueSettings) as object,
          subjectPool: (c.subjectPool as object) ?? undefined,
          fromNamePool: (c.fromNamePool as object) ?? undefined,
          utmSource: c.utmSource,
          utmMedium: c.utmMedium,
          utmCampaign: c.utmCampaign,
        },
      });

      return reply.status(201).send({ campaign });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: {
          list: true,
          segment: true,
          template: true,
          domain: true,
          provider: {
            select: {
              id: true,
              name: true,
              type: true,
              isDefault: true,
              isActive: true,
            },
          },
          // Don't eager-load 500 recipients here (slow). Use GET /campaigns/:id/recipients?pagination instead.
        },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      const queueSettings = withRecommendedPacing(campaign.queueSettings);
      // Attach a lightweight summary count so the UI can still show "x recipients" without loading them all
      const totalRecipientsCount = await prisma.campaignRecipient.count({ where: { campaignId: id } });
      return reply.send({
        campaign: {
          ...campaign,
          queueSettings,
          recipients: undefined, // remove field (kept for type compat; will serialize as `undefined` i.e. omitted)
          _meta: {
            recipientCount: totalRecipientsCount,
          },
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/send-status/stream', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };

      const initial = await buildCampaignSendStatus(orgId, id, { activityLimit: 80 });
      if (!initial) throw new AppError(404, 'Campaign not found');

      const SSE_KEEPALIVE_MS = 15_000;
      const SSE_POLL_MS = 2_000;

      reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      const origin = String(request.headers.origin || '');
      const allowed = (await import('../../config/env.js')).env.CORS_ORIGIN.split(',').map((s) =>
        s.trim(),
      );
      if (origin && allowed.includes(origin)) {
        reply.raw.setHeader('Access-Control-Allow-Origin', origin);
        reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
        reply.raw.setHeader('Vary', 'Origin');
      }
      if (reply.raw.socket) {
        reply.raw.socket.setNoDelay(true);
        reply.raw.socket.setKeepAlive(true, SSE_KEEPALIVE_MS);
      }
      reply.raw.flushHeaders?.();

      let stopped = false;
      let lastKey = '';
      let polling = false;
      const send = (evt: string, data: Record<string, unknown>) => {
        if (stopped) return;
        const chunk =
          (evt ? `event: ${evt}\n` : '') + `data: ${JSON.stringify(data)}\n\n`;
        try {
          reply.raw.write(chunk);
        } catch {
          /* client gone */
        }
      };

      const fingerprint = (p: Awaited<ReturnType<typeof buildCampaignSendStatus>>) =>
        p
          ? [
              p.status,
              p.sentCount,
              p.failedCount,
              p.pendingCount,
              p.openedCount,
              p.clickedCount,
              p.activity?.[p.activity.length - 1]?.at,
              p.activity?.length,
              p.queueStage,
              p.pauseUntil,
              p.lastEmail,
            ].join('|')
          : '';

      lastKey = fingerprint(initial);
      send('status', initial);

      const poll = setInterval(async () => {
        if (stopped || polling) return;
        polling = true;
        try {
          const fresh = await buildCampaignSendStatus(orgId, id, { activityLimit: 80 });
          if (!fresh) {
            send('error', { message: 'Campaign not found' });
            stop();
            return;
          }
          const key = fingerprint(fresh);
          if (key !== lastKey) {
            lastKey = key;
            send('status', fresh);
          }
          send('ping', { t: Date.now() });
        } catch {
          /* ignore transient poll errors */
        } finally {
          polling = false;
        }
      }, SSE_POLL_MS);

      const keepalive = setInterval(() => send('ping', { t: Date.now() }), SSE_KEEPALIVE_MS);

      function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(poll);
        clearInterval(keepalive);
        try {
          reply.raw.end();
        } catch {
          /* already closed */
        }
      }

      reply.raw.on('close', stop);
      reply.raw.on('error', stop);

      if (
        initial.status === 'SENT' ||
        initial.status === 'FAILED' ||
        initial.status === 'CANCELLED'
      ) {
        setTimeout(() => stop(), 60_000);
      }

      return reply;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/check-audience', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: { listId: true, segmentId: true, organizationId: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      const { ok, skipped, total } = await inspectCampaignAudience(campaign);
      return reply.send({
        total,
        sendable: ok.length,
        skipped: skipped.length,
        samples: skipped.slice(0, 40),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/remove-bounces', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true, listId: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      const bounced = await prisma.campaignRecipient.findMany({
        where: { campaignId: id, status: 'BOUNCED' },
        select: { contactId: true },
      });
      const ids = [...new Set(bounced.map((r) => r.contactId))];
      const result = await removeContactsFromAudience(orgId, ids);
      return reply.send({ ...result, bounced: ids.length });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/send-status', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const payload = await buildCampaignSendStatus(orgId, id, { activityLimit: 4_000 });
      if (!payload) throw new AppError(404, 'Campaign not found');
      return reply.send(payload);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          name: z.string().optional(),
          type: z.enum(['REGULAR', 'SCHEDULED', 'AUTOMATED', 'DRIP']).optional(),
          subject: z.string().optional().nullable(),
          previewText: z.string().optional().nullable(),
          senderName: z.string().optional().nullable(),
          senderEmail: z.string().optional().nullable(),
          replyTo: z.string().optional().nullable(),
          htmlContent: z.string().optional().nullable(),
          plainTextContent: z.string().optional().nullable(),
          editorJson: z.unknown().optional(),
          listId: z.string().optional().nullable(),
          segmentId: z.string().optional().nullable(),
          templateId: z.string().optional().nullable(),
          domainId: z.string().optional().nullable(),
          providerId: z.string().optional().nullable(),
          trackOpens: z.boolean().optional(),
          trackClicks: z.boolean().optional(),
          utmSource: z.string().optional().nullable(),
          utmMedium: z.string().optional().nullable(),
          utmCampaign: z.string().optional().nullable(),
          scheduledAt: z.string().datetime().optional().nullable(),
          timezone: z.string().optional(),
          queueSettings: z
            .object({
              batchSize: z.number().min(1).max(500).optional(),
              batchPauseMs: z.number().min(0).max(600_000).optional(),
              betweenEmailMs: z.number().min(0).max(120_000).optional(),
              maxConcurrent: z.number().min(1).max(20).optional(),
              maxPerMinute: z.number().min(1).max(600).optional(),
              maxPerHour: z.number().min(1).max(50_000).optional(),
              sendChannel: z.enum(['smtp', 'api']).optional(),
              maxFailPercent: z.number().min(0).max(100).optional(),
              maxFailMinProcessed: z.number().min(1).max(10_000).optional(),
              providerIds: z.array(z.string().min(1)).max(40).optional(),
            })
            .passthrough()
            .optional()
            .nullable(),
          subjectPool: z.array(z.string()).optional().nullable(),
          fromNamePool: z.array(z.string()).optional().nullable(),
          templatePool: z.array(z.string()).optional().nullable(),
        })
        .parse(request.body);

      const existing = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!existing) throw new AppError(404, 'Campaign not found');
      if (existing.status === 'SENDING') {
        if (!body.queueSettings || typeof body.queueSettings !== 'object') {
          throw new AppError(400, 'Cannot edit a campaign while it is sending');
        }
        const queueSettings = withRecommendedPacing({
          ...(existing.queueSettings && typeof existing.queueSettings === 'object'
            ? (existing.queueSettings as Record<string, unknown>)
            : {}),
          ...body.queueSettings,
        });
        const campaign = await prisma.campaign.update({
          where: { id },
          data: { queueSettings: queueSettings as Prisma.InputJsonValue },
        });
        return reply.send({ campaign });
      }

      const {
        subjectPool,
        fromNamePool,
        templatePool,
        templateId,
        listId,
        segmentId,
        providerId,
        domainId,
        scheduledAt,
        queueSettings,
        editorJson,
        ...scalars
      } = body;
      const data: Prisma.CampaignUpdateInput = {
        ...scalars,
        editorJson: editorJson as object | undefined,
        queueSettings:
          queueSettings === undefined
            ? undefined
            : queueSettings === null
              ? Prisma.DbNull
              : (withRecommendedPacing({
                  ...(existing.queueSettings && typeof existing.queueSettings === 'object'
                    ? (existing.queueSettings as Record<string, unknown>)
                    : {}),
                  ...queueSettings,
                }) as object),
        subjectPool:
          subjectPool === undefined
            ? undefined
            : subjectPool === null
              ? Prisma.DbNull
              : (subjectPool as Prisma.InputJsonValue),
        fromNamePool:
          fromNamePool === undefined
            ? undefined
            : fromNamePool === null
              ? Prisma.DbNull
              : (fromNamePool as Prisma.InputJsonValue),
        templatePool:
          templatePool === undefined
            ? undefined
            : templatePool === null
              ? Prisma.DbNull
              : (templatePool as Prisma.InputJsonValue),
        template:
          templateId === undefined
            ? undefined
            : templateId
              ? { connect: { id: templateId } }
              : { disconnect: true },
        list:
          listId === undefined ? undefined : listId ? { connect: { id: listId } } : { disconnect: true },
        segment:
          segmentId === undefined
            ? undefined
            : segmentId
              ? { connect: { id: segmentId } }
              : { disconnect: true },
        provider:
          providerId === undefined
            ? undefined
            : providerId && providerId !== 'rotate' && providerId !== 'auto'
              ? { connect: { id: providerId } }
              : { disconnect: true },
        scheduledAt: scheduledAt ? new Date(scheduledAt) : scheduledAt === null ? null : undefined,
      };
      // Edits reset draft campaigns; never downgrade an active send to DRAFT.
      if (!['SENDING', 'SENT', 'PAUSED', 'CANCELLED'].includes(existing.status)) {
        data.status = 'DRAFT';
      }
      const senderForLink =
        body.senderEmail !== undefined ? body.senderEmail : existing.senderEmail;
      if (domainId !== undefined) {
        data.domain = domainId ? { connect: { id: domainId } } : { disconnect: true };
      } else {
        const linked = await domainIdForSender(orgId, senderForLink);
        data.domain = linked ? { connect: { id: linked } } : { disconnect: true };
      }
      if (
        body.subject !== undefined ||
        body.previewText !== undefined ||
        body.htmlContent !== undefined ||
        body.plainTextContent !== undefined
      ) {
        const scrubbed = scrubCampaignContent({
          subject: body.subject !== undefined ? body.subject : existing.subject,
          previewText: body.previewText !== undefined ? body.previewText : existing.previewText,
          htmlContent: body.htmlContent !== undefined ? body.htmlContent : existing.htmlContent,
          plainTextContent:
            body.plainTextContent !== undefined ? body.plainTextContent : existing.plainTextContent,
        });
        data.subject = scrubbed.subject;
        data.previewText = scrubbed.previewText;
        data.htmlContent = scrubbed.htmlContent;
        data.plainTextContent = scrubbed.plainTextContent;
      }
      const campaign = await prisma.campaign.update({
        where: { id },
        data,
      });
      return reply.send({ campaign });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/analyze', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: { organization: true, domain: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const report = analyzeCampaign({
        subject: campaign.subject,
        previewText: campaign.previewText,
        htmlContent: campaign.htmlContent,
        plainTextContent: campaign.plainTextContent,
        senderName: campaign.senderName,
        senderEmail: campaign.senderEmail,
        physicalAddress: campaign.organization.physicalAddress,
        authStatus: campaign.domain
          ? {
              spf: campaign.domain.spfValid,
              dkim: campaign.domain.dkimValid,
              dmarc: campaign.domain.dmarcValid,
              bimi: campaign.domain.bimiValid,
            }
          : undefined,
      });

      const updated = await prisma.campaign.update({
        where: { id },
        data: {
          deliverabilityScore: report.score,
          inboxReadinessScore: report.inboxReadiness.overall,
          analysisReport: report as object,
          status: report.rating === 'high_risk' ? 'DRAFT' : 'READY',
        },
      });

      return reply.send({ campaign: updated, report });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/scrub', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (['SENDING', 'SENT'].includes(campaign.status)) {
        throw new AppError(400, 'Cannot scrub a campaign that is sending or sent');
      }

      const scrubbed = scrubCampaignContent(campaign);
      const updated = await prisma.campaign.update({
        where: { id },
        data: {
          subject: scrubbed.subject,
          previewText: scrubbed.previewText,
          htmlContent: scrubbed.htmlContent,
          plainTextContent: scrubbed.plainTextContent,
          status: 'DRAFT',
        },
      });

      return reply.send({ campaign: updated, scrubbed });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Prepare recipients for human-like sequential send (Nexlogs-style). */
  app.post('/:id/prepare-send', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          providerId: z.string().optional().nullable(),
          force: z.boolean().default(false),
          scrub: z.boolean().default(true),
        })
        .parse(request.body ?? {});

      let campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: { organization: true, domain: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (!campaign.subject || !campaign.htmlContent) {
        throw new AppError(400, 'Campaign needs subject and content before sending');
      }
      if (!campaign.listId && !campaign.segmentId) {
        throw new AppError(400, 'Select a list or segment');
      }

      if (body.scrub) {
        const scrubbed = scrubCampaignContent(campaign);
        const remaining = findRemainingSpamPhrases(
          `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.htmlContent}\n${scrubbed.plainTextContent}`,
        );
        campaign = await prisma.campaign.update({
          where: { id },
          data: {
            subject: scrubbed.subject,
            previewText: scrubbed.previewText,
            htmlContent: scrubbed.htmlContent,
            plainTextContent: scrubbed.plainTextContent,
            providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
          },
          include: { organization: true, domain: true },
        });
        if (remaining.length && !body.force) {
          return reply.status(400).send({
            error: `Spam phrases remain after scrub: ${remaining.join(', ')}. Fix content or pass force=true.`,
            remaining,
          });
        }
      } else if (body.providerId !== undefined) {
        campaign = await prisma.campaign.update({
          where: { id },
          data: { providerId: body.providerId },
          include: { organization: true, domain: true },
        });
      }

      const report = analyzeCampaign({
        subject: campaign.subject,
        previewText: campaign.previewText,
        htmlContent: campaign.htmlContent,
        plainTextContent: campaign.plainTextContent,
        physicalAddress: campaign.organization.physicalAddress,
        authStatus: campaign.domain
          ? {
              spf: campaign.domain.spfValid,
              dkim: campaign.domain.dkimValid,
              dmarc: campaign.domain.dmarcValid,
            }
          : undefined,
      });

      if (report.rating === 'high_risk' && !body.force) {
        return reply.status(400).send({
          error:
            'Deliverability score is high risk. Fix issues or pass force=true to proceed with caution.',
          report,
        });
      }

      const contacts = await collectCampaignContacts(campaign);
      if (!contacts.length) throw new AppError(400, 'No eligible recipients');

      const recipients: Array<{ id: string; contactId: string }> = [];
      const UPSERT_CHUNK = 50;
      for (let i = 0; i < contacts.length; i += UPSERT_CHUNK) {
        const slice = contacts.slice(i, i + UPSERT_CHUNK);
        const chunk = await Promise.all(
          slice.map((contact) =>
            prisma.campaignRecipient.upsert({
              where: {
                campaignId_contactId: { campaignId: id, contactId: contact.id },
              },
              create: {
                campaignId: id,
                contactId: contact.id,
                status: 'QUEUED',
              },
              update: { status: 'QUEUED', error: null, messageId: null, sentAt: null },
            }),
          ),
        );
        recipients.push(...chunk);
      }

      const total = contacts.length;

      await prisma.campaign.update({
        where: { id },
        data: {
          status: 'SENDING',
          sentAt: new Date(),
          sentCount: 0,
          failedCount: 0,
          totalRecipients: total,
          deliverabilityScore: report.score,
          analysisReport: report as object,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
        },
      });

      let jobId: string | null = null;
      try {
        const { randomUUID } = await import('node:crypto');
        jobId = randomUUID();
        await upsertJobProgress({
          id: jobId,
          type: 'CAMPAIGN_SEND',
          organizationId: orgId,
          createdById: request.user?.id ?? null,
          campaignId: id,
          status: 'RUNNING',
          total,
          processed: 0,
          startedAt: new Date(),
          meta: { stage: 'prepared', sent: 0, failed: 0, queued: total, report: report as unknown as Prisma.InputJsonValue },
        });
      } catch {}

      return reply.send({
        success: true,
        report,
        totalRecipients: total,
        jobId,
        recipients:
          total > 2_000
            ? []
            : recipients.map((r, i) => ({
                id: r.id,
                contactId: contacts[i]!.id,
                email: contacts[i]!.email,
                displayName:
                  [contacts[i]!.firstName, contacts[i]!.lastName].filter(Boolean).join(' ') ||
                  contacts[i]!.email.split('@')[0],
              })),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/tracking-apply', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          events: z
            .array(
              z.object({
                id: z.string().min(1).max(80),
                organizationId: z.string().optional(),
                campaignId: z.string().min(1).max(80),
                contactId: z.string().min(1).max(80),
                email: z.string().nullable().optional(),
                type: z.enum(['OPENED', 'CLICKED', 'UNSUBSCRIBED']),
                url: z.string().nullable().optional(),
                createdAt: z.string().optional(),
              }),
            )
            .max(200),
        })
        .parse(request.body || {});
      const { applyRelayEventsLocal } = await import('../../services/email/tracking-relay.js');
      const applied = await applyRelayEventsLocal(
        orgId,
        body.events.map((event) => ({
          ...event,
          organizationId: orgId,
          email: event.email ?? null,
          url: event.url ?? null,
          createdAt: event.createdAt || new Date().toISOString(),
        })),
      );
      return reply.send({ applied });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/send-one', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          recipientId: z.string(),
          providerId: z.string().optional().nullable(),
          jobId: z.string().optional(),
        })
        .parse(request.body);

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true, status: true, providerId: true, totalRecipients: true, sentCount: true, failedCount: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (campaign.status === 'CANCELLED') throw new AppError(400, 'Campaign was cancelled');
      if (campaign.status === 'PAUSED') throw new AppError(400, 'Campaign is paused');

      const recipient = await prisma.campaignRecipient.findFirst({
        where: { id: body.recipientId, campaignId: id },
        include: { contact: true },
      });
      if (!recipient) throw new AppError(404, 'Recipient not found');

      const result = await sendCampaignEmailToRecipient({
        campaignId: id,
        recipientId: recipient.id,
        contactId: recipient.contactId,
        to: recipient.contact.email,
        providerId: body.providerId ?? campaign.providerId,
        cloudAuthorization: request.headers.authorization,
      });

      let jobId: string | null = body.jobId?.trim() || null;
      try {
        const jobTotal = Math.max(1, Number(campaign.totalRecipients) || 1);
        let jobProcessed = 0;
        let sentCountVal = Number(campaign.sentCount) || 0;
        let failedCountVal = Number(campaign.failedCount) || 0;
        if (result.success) sentCountVal++;
        else failedCountVal++;

        if (!jobId) {
          const found = await prisma.job.findFirst({
            where: { organizationId: orgId, campaignId: id, type: 'CAMPAIGN_SEND', status: 'RUNNING' },
            orderBy: [{ createdAt: 'desc' }],
            select: { id: true, processed: true },
          });
          if (found) { jobId = found.id; jobProcessed = Number(found.processed) || 0; }
        }
        if (jobId) {
          jobProcessed = Math.min(jobTotal, jobProcessed + 1);
          await upsertJobProgress({
            id: jobId,
            type: 'CAMPAIGN_SEND',
            organizationId: orgId,
            createdById: request.user?.id ?? null,
            campaignId: id,
            status: 'RUNNING',
            total: jobTotal,
            processed: jobProcessed,
            meta: { stage: 'sending', sent: sentCountVal, failed: failedCountVal, lastEmail: recipient.contact.email },
          });
        }
      } catch {}

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error, jobId });
      }

      return reply.send({ success: true, messageId: result.messageId, jobId });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/finalize-send', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          cancelled: z.boolean().default(false),
          jobId: z.string().optional(),
        })
        .parse(request.body ?? {});

      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const [sentCount, failedCount, pendingCount] = await Promise.all([
        prisma.campaignRecipient.count({ where: deliveredRecipientFilter(id) }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'FAILED' } }),
        prisma.campaignRecipient.count({
          where: { campaignId: id, status: 'QUEUED' },
        }),
      ]);

      const status = body.cancelled
        ? 'CANCELLED'
        : pendingCount > 0
          ? 'PAUSED'
          : failedCount > 0 && sentCount === 0
            ? 'FAILED'
            : 'SENT';

      const updated = await prisma.campaign.update({
        where: { id },
        data: {
          status,
          sentCount,
          failedCount,
          completedAt: status === 'SENT' || status === 'CANCELLED' ? new Date() : null,
        },
      });

      if (status === 'SENT' || status === 'CANCELLED') {
        await recountCampaignEngagement(id);
      }

      let jobId: string | null = body.jobId?.trim() || null;
      try {
        const jobTotal = Math.max(1, Number(updated.totalRecipients) || sentCount + failedCount + pendingCount);
        if (!jobId) {
          const found = await prisma.job.findFirst({
            where: { organizationId: orgId, campaignId: id, type: 'CAMPAIGN_SEND' },
            orderBy: [{ createdAt: 'desc' }],
            select: { id: true },
          });
          if (found) jobId = found.id;
        }
        if (jobId) {
          const jobStatus =
            status === 'CANCELLED'
              ? 'CANCELLED'
              : status === 'FAILED'
                ? 'FAILED'
                : status === 'PAUSED'
                  ? 'PAUSED'
                  : 'COMPLETED';
          await upsertJobProgress({
            id: jobId,
            type: 'CAMPAIGN_SEND',
            organizationId: orgId,
            createdById: request.user?.id ?? null,
            campaignId: id,
            status: jobStatus as any,
            total: jobTotal,
            processed: Math.min(jobTotal, sentCount + failedCount),
            finishedAt: new Date(),
            meta: { stage: status === 'CANCELLED' ? 'cancelled' : 'finalized', sent: sentCount, failed: failedCount, pending: pendingCount },
          });
        }
      } catch {}

      return reply.send({ campaign: updated, sentCount, failedCount, pendingCount, jobId });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/send', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          scheduledAt: z.string().datetime().optional(),
          force: z.boolean().default(false),
          providerId: z.string().optional().nullable(),
          mode: z.enum(['queue', 'sequential']).default('sequential'),
        })
        .parse(request.body ?? {});

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: { organization: true, domain: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (!campaign.subject || !campaign.htmlContent) {
        throw new AppError(400, 'Campaign needs subject and content before sending');
      }
      if (!campaign.listId && !campaign.segmentId) {
        throw new AppError(400, 'Select a list or segment');
      }

      if (body.providerId !== undefined) {
        await prisma.campaign.update({
          where: { id },
          data: { providerId: body.providerId },
        });
      }

      const scrubbed = scrubCampaignContent({
        subject: campaign.subject,
        previewText: campaign.previewText,
        htmlContent: campaign.htmlContent,
        plainTextContent: campaign.plainTextContent,
      });
      const remainingSpam = findRemainingSpamPhrases(
        `${scrubbed.subject}\n${scrubbed.previewText}\n${scrubbed.plainTextContent}\n${scrubbed.htmlContent}`,
      );
      if (remainingSpam.length && !body.force) {
        return reply.status(400).send({
          error: `Spam phrases remain after scrub: ${remainingSpam.join(', ')}. Fix content or pass force=true.`,
          remaining: remainingSpam,
        });
      }
      if (scrubbed.changed) {
        await prisma.campaign.update({
          where: { id },
          data: {
            subject: scrubbed.subject,
            previewText: scrubbed.previewText,
            htmlContent: scrubbed.htmlContent,
            plainTextContent: scrubbed.plainTextContent,
          },
        });
      }

      const report = analyzeCampaign({
        subject: scrubbed.subject,
        previewText: scrubbed.previewText,
        htmlContent: scrubbed.htmlContent,
        plainTextContent: scrubbed.plainTextContent,
        physicalAddress: campaign.organization.physicalAddress,
        authStatus: campaign.domain
          ? {
              spf: campaign.domain.spfValid,
              dkim: campaign.domain.dkimValid,
              dmarc: campaign.domain.dmarcValid,
            }
          : undefined,
      });

      if (report.rating === 'high_risk' && !body.force) {
        return reply.status(400).send({
          error:
            'Deliverability score is high risk. Fix issues or pass force=true to proceed with caution.',
          report,
        });
      }

      if (body.mode === 'sequential') {
        return reply.send({
          success: true,
          mode: 'sequential',
          message: 'Use prepare-send + send-one for human-like sequential delivery',
          report,
        });
      }

      if (body.scheduledAt) {
        const scheduledAt = new Date(body.scheduledAt);
        await prisma.campaign.update({
          where: { id },
          data: {
            status: 'SCHEDULED',
            scheduledAt,
            type: 'SCHEDULED',
            deliverabilityScore: report.score,
            analysisReport: report as object,
          },
        });
        const delay = Math.max(0, scheduledAt.getTime() - Date.now());
        await enqueueCampaignScheduled(id, delay);
        return reply.send({ success: true, status: 'SCHEDULED', scheduledAt, report });
      }

      const job = await ensureCampaignSendJob({
        campaignId: id,
        organizationId: orgId,
        createdById: request.user?.id ?? null,
        total: campaign.totalRecipients || 0,
      });
      await prisma.campaign.update({
        where: { id },
        data: {
          status: 'SENDING',
          sentAt: campaign.sentAt ?? new Date(),
          deliverabilityScore: report.score,
          analysisReport: report as object,
        },
      });
      await enqueueCampaign(id);
      return reply.send({
        success: true,
        status: 'SENDING',
        mode: 'queue',
        background: true,
        jobId: job.id,
        totalRecipients: campaign.totalRecipients || 0,
        report,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/pause', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const existing = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: { status: true },
      });
      if (!existing) throw new AppError(404, 'Campaign not found');
      if (existing.status === 'PAUSED') {
        return reply.send({ success: true, status: 'PAUSED' });
      }
      if (existing.status !== 'SENDING') {
        throw new AppError(400, `Cannot pause campaign in status ${existing.status}`);
      }
      await prisma.campaign.update({
        where: { id },
        data: { status: 'PAUSED' },
      });
      await drainCampaignJobs(id);
      await writeSystemLog({
        organizationId: orgId,
        level: 'WARNING',
        category: 'queue',
        message: `Campaign paused: ${id}`,
      });
      return reply.send({ success: true, status: 'PAUSED' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/resume', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (campaign.status !== 'PAUSED') throw new AppError(400, 'Only paused campaigns can resume');

      await prisma.campaign.update({ where: { id }, data: { status: 'SENDING' } });
      await ensureCampaignSendJob({
        campaignId: id,
        organizationId: orgId,
        createdById: request.user?.id ?? null,
        total: campaign.totalRecipients || 0,
      });
      await enqueueCampaign(id);
      const queued = await prisma.campaignRecipient.count({
        where: { campaignId: id, status: 'QUEUED' },
      });
      await writeSystemLog({
        organizationId: orgId,
        level: 'INFO',
        category: 'queue',
        message: `Campaign resumed: ${id} (${queued} pending)`,
      });
      return reply.send({
        success: true,
        status: 'SENDING',
        pendingCount: queued,
        queueSettings: campaign.queueSettings,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/recount-engagement', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      const result = await recountCampaignEngagement(id);
      return reply.send({ success: true, ...result });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/resend', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          force: z.boolean().default(true),
          providerId: z.string().optional().nullable(),
          listId: z.string().optional().nullable(),
        })
        .parse(request.body ?? {});

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: { organization: true, domain: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (campaign.status === 'SENDING') {
        throw new AppError(400, 'This campaign is already sending');
      }
      if (!campaign.subject || !campaign.htmlContent) {
        throw new AppError(400, 'Campaign needs subject and content before sending');
      }

      const listId = body.listId || campaign.listId;
      const segmentId = listId ? null : campaign.segmentId;
      if (!listId && !segmentId) {
        throw new AppError(400, 'Select a list or segment');
      }
      let queuedEstimate = 0;
      if (listId) {
        const list = await prisma.contactList.findFirst({
          where: { id: listId, organizationId: orgId },
          select: { id: true },
        });
        if (!list) throw new AppError(400, 'Audience list not found');
        queuedEstimate = await prisma.contactListMember.count({
          where: { listId, contact: { status: 'SUBSCRIBED' } },
        });
        if (queuedEstimate < 1) {
          throw new AppError(400, 'That list has no subscribed contacts to send to');
        }
      }

      const report = analyzeCampaign({
        subject: campaign.subject,
        previewText: campaign.previewText,
        htmlContent: campaign.htmlContent,
        plainTextContent: campaign.plainTextContent,
        physicalAddress: campaign.organization.physicalAddress,
        authStatus: campaign.domain
          ? {
              spf: campaign.domain.spfValid,
              dkim: campaign.domain.dkimValid,
              dmarc: campaign.domain.dmarcValid,
            }
          : undefined,
      });
      if (report.rating === 'high_risk' && !body.force) {
        return reply.status(400).send({
          error: 'Deliverability score is high risk. Pass force=true to resend.',
          report,
        });
      }

      const baseName = await nextResendName(orgId, campaign.name);
      const sameAudience = Boolean(listId && campaign.listId && listId === campaign.listId);

      if (sameAudience) {
        const memberIds = (
          await prisma.contactListMember.findMany({
            where: { listId: listId!, contact: { status: 'SUBSCRIBED' } },
            select: { contactId: true },
          })
        ).map((m) => m.contactId);
        await resetCampaignForResend(id, memberIds);
        await prisma.campaign.update({
          where: { id },
          data: {
            status: 'SENDING',
            completedAt: null,
            sentCount: 0,
            failedCount: 0,
            totalRecipients: queuedEstimate,
            providerId: body.providerId !== undefined ? body.providerId : campaign.providerId,
            listId,
            sentAt: campaign.sentAt ?? new Date(),
            deliverabilityScore: report.score,
            analysisReport: report as object,
          },
        });
        await ensureCampaignSendJob({
          campaignId: id,
          organizationId: orgId,
          createdById: request.user?.id ?? null,
          total: queuedEstimate,
        });
        await enqueueCampaign(id);
        await writeSystemLog({
          organizationId: orgId,
          level: 'INFO',
          category: 'queue',
          message: `Resend merged into ${id} (same list ${listId})`,
        });
        return reply.send({
          success: true,
          status: 'SENDING',
          campaignId: id,
          parentCampaignId: id,
          merged: true,
          name: campaign.name,
          totalRecipients: queuedEstimate,
          queued: queuedEstimate,
          report,
        });
      }

      const copy = await prisma.campaign.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: baseName,
          type: campaign.type,
          subject: campaign.subject,
          previewText: campaign.previewText,
          senderName: campaign.senderName,
          senderEmail: campaign.senderEmail,
          replyTo: campaign.replyTo,
          htmlContent: campaign.htmlContent,
          plainTextContent: campaign.plainTextContent,
          editorJson: campaign.editorJson ?? undefined,
          listId,
          segmentId,
          templateId: campaign.templateId,
          templatePool: campaign.templatePool ?? undefined,
          subjectPool: campaign.subjectPool ?? undefined,
          fromNamePool: campaign.fromNamePool ?? undefined,
          queueSettings: campaign.queueSettings ?? undefined,
          providerId: body.providerId !== undefined ? body.providerId : campaign.providerId,
          domainId: campaign.domainId,
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
          utmSource: campaign.utmSource,
          utmMedium: campaign.utmMedium,
          utmCampaign: `resend-${id.slice(-8)}`,
          status: 'SENDING',
          sentAt: new Date(),
          totalRecipients: queuedEstimate,
          deliverabilityScore: report.score,
          analysisReport: report as object,
        },
      });

      await ensureCampaignSendJob({
        campaignId: copy.id,
        organizationId: orgId,
        createdById: request.user?.id ?? null,
        total: queuedEstimate,
      });
      await enqueueCampaign(copy.id);

      await writeSystemLog({
        organizationId: orgId,
        level: 'INFO',
        category: 'queue',
        message: `Resend cloned ${id} → ${copy.id} (list ${listId || 'segment'})`,
      });

      return reply.send({
        success: true,
        status: 'SENDING',
        campaignId: copy.id,
        parentCampaignId: id,
        name: copy.name,
        totalRecipients: queuedEstimate,
        queued: queuedEstimate,
        report,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/retry-failed', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const reset = await prisma.campaignRecipient.updateMany({
        where: { campaignId: id, status: 'FAILED' },
        data: { status: 'QUEUED', error: null, messageId: null, sentAt: null },
      });
      await prisma.campaign.update({
        where: { id },
        data: { status: 'SENDING', completedAt: null },
      });
      await ensureCampaignSendJob({
        campaignId: id,
        organizationId: orgId,
        createdById: request.user?.id ?? null,
        total: campaign.totalRecipients || reset.count,
      });
      await enqueueCampaign(id);

      await writeSystemLog({
        organizationId: orgId,
        level: 'INFO',
        category: 'queue',
        message: `Retrying ${reset.count} failed recipients: ${id}`,
      });

      return reply.send({
        success: true,
        status: 'SENDING',
        retried: reset.count,
        queueSettings: campaign.queueSettings,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/progress', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const [sent, failed, queued] = await Promise.all([
        prisma.campaignRecipient.count({ where: deliveredRecipientFilter(id) }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'FAILED' } }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'QUEUED' } }),
      ]);
      const total = campaign.totalRecipients || sent + failed + queued;
      const remaining = Math.max(0, total - sent - failed);
      const elapsedMs = campaign.sentAt ? Date.now() - campaign.sentAt.getTime() : 0;
      const speed = elapsedMs > 0 ? sent / (elapsedMs / 60_000) : 0;
      const etaSeconds = speed > 0 ? Math.round((remaining / speed) * 60) : null;

      return reply.send({
        progress: {
          status: campaign.status,
          total,
          sent,
          failed,
          remaining,
          success: sent,
          percent: total ? Math.round(((sent + failed) / total) * 100) : 0,
          speedPerMinute: Math.round(speed * 10) / 10,
          etaSeconds,
          queueSettings: campaign.queueSettings,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/cancel', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.campaign.updateMany({
        where: {
          id,
          organizationId: orgId,
          status: { in: ['SENDING', 'PAUSED', 'READY', 'SCHEDULED', 'FAILED', 'DRAFT'] },
        },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      await drainCampaignJobs(id);
      return reply.send({ success: true, status: 'CANCELLED' });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** QA: send subject × sender-name combinations to a test inbox before a big send. */
  app.post('/:id/test-matrix', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          to: z.string().email(),
          subjects: z.array(z.string().min(1)).min(1).max(8),
          fromNames: z.array(z.string()).max(8).optional(),
          /** Placement tests: omit [TEST] prefix for a more realistic message. */
          noSubjectPrefix: z.boolean().optional(),
          templateIds: z.array(z.string().min(1)).max(12).optional(),
          htmlByTemplateId: z.record(z.string()).optional(),
          /** One placement message per From saved on the SMTP (not used for live campaigns). */
          allFromIdentities: z.boolean().optional(),
          /** Ticked SMTPs on the campaign SMTP/Proxy tab. */
          providerIds: z.array(z.string().min(1)).max(40).optional(),
        })
        .parse(request.body);

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        include: { organization: true, domain: true },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const { parseProviderConfig } = await import('../../services/email/providers.js');
      const { resolveRotatedProviders, parseRotationSettings } = await import(
        '../../services/email/smtp-rotation.js'
      );

      const rotation = parseRotationSettings(campaign.organization.sendSettings);
      const qs = (campaign.queueSettings || {}) as {
        sendChannel?: 'smtp' | 'api';
        providerIds?: string[];
      };
      const sendChannel = qs.sendChannel === 'api' || qs.sendChannel === 'smtp' ? qs.sendChannel : null;
      const pool = await resolveRotatedProviders({
        organizationId: orgId,
        preferredProviderId: campaign.providerId,
        rotation: { ...rotation, enabled: false },
        sendChannel,
      });
      const wantedIds = [
        ...new Set(
          (body.providerIds?.length
            ? body.providerIds
            : Array.isArray(qs.providerIds) && qs.providerIds.length
              ? qs.providerIds
              : campaign.providerId
                ? [campaign.providerId]
                : []
          ).map((x) => String(x)),
        ),
      ];
      const byId = new Map(pool.map((p) => [p.id, p]));
      const providers = (wantedIds.length ? wantedIds.map((pid) => byId.get(pid)).filter(Boolean) : pool) as typeof pool;
      if (!providers.length) throw new AppError(400, 'No active SMTP or API provider');

      let fromEmail = String(campaign.senderEmail || '').trim();
      const defaultFromName = body.fromNames?.find((n) => n.trim()) || campaign.senderName || '';

      const poolFromCampaign = [
        ...(Array.isArray(campaign.templatePool)
          ? campaign.templatePool.map((x) => String(x || '').trim()).filter(Boolean)
          : []),
        ...(campaign.templateId ? [campaign.templateId] : []),
      ];
      const requestedIds = (body.templateIds || []).map((x) => String(x).trim()).filter(Boolean);
      const templateIds = [...new Set(requestedIds.length ? requestedIds : poolFromCampaign)];
      const templates = templateIds.length
        ? await prisma.template.findMany({
            where: {
              id: { in: templateIds },
              OR: [{ organizationId: orgId }, { isPublic: true }],
            },
            select: { id: true, name: true, htmlContent: true, plainText: true },
          })
        : [];
      const templateById = new Map(templates.map((t) => [t.id, t]));
      const letterText = (html: string, plain?: string | null) => {
        const saved = String(plain || '').trim();
        if (saved && !/^test matrix message$/i.test(saved)) return saved;
        return stripHtmlTags(html);
      };
      const variants: Array<{ id: string | null; name: string | null; html: string; text: string }> =
        templateIds.length
          ? templateIds.map((tid) => {
              const override = body.htmlByTemplateId?.[tid]?.trim();
              const tpl = templateById.get(tid);
              const html = override || tpl?.htmlContent?.trim() || campaign.htmlContent || '';
              return {
                id: tid,
                name: tpl?.name || null,
                html,
                text: letterText(html, tpl?.plainText || campaign.plainTextContent),
              };
            })
          : [
              {
                id: campaign.templateId || null,
                name: null,
                html: campaign.htmlContent || '',
                text: letterText(campaign.htmlContent || '', campaign.plainTextContent),
              },
            ];

      const results: Array<{
        subject: string;
        fromName: string;
        fromEmail?: string;
        providerName?: string;
        providerHost?: string | null;
        templateId?: string | null;
        templateName?: string | null;
        success: boolean;
        messageId?: string;
        smtpResponse?: string;
        error?: string;
      }> = [];

      let first = true;
      for (const provider of providers) {
        const cfg = parseProviderConfig(provider.config);
        const smtpHost = String(cfg.host || '').trim().toLowerCase();
        if (provider.type === 'SMTP' && (smtpHost === 'json' || smtpHost === 'dev' || smtpHost === 'console')) {
          throw new AppError(400, 'SMTP is in mock mode — no mail is delivered. Save a real SMTP host first.');
        }
        const smtpFroms = body.allFromIdentities ? parseSmtpFromIdentities(cfg) : [];
        const fromSlots =
          smtpFroms.length > 0
            ? smtpFroms.map((ident) => ({
                email: ident.email,
                name: ident.name || defaultFromName || cfg.fromName || '',
              }))
            : [{ email: String(cfg.fromEmail || '').trim(), name: defaultFromName || cfg.fromName || '' }];

        for (const variant of variants) {
          for (const subject of body.subjects) {
            for (const slot of fromSlots) {
              if (!first) {
                await new Promise((r) => setTimeout(r, 700));
              }
              first = false;
              const result = await sendPlacementMessage({
                campaignId: id,
                to: body.to,
                subject: body.noSubjectPrefix ? subject : `[TEST] ${subject}`,
                html: variant.html,
                text: variant.text,
                fromName: slot.name.trim() || undefined,
                fromEmail: slot.email || undefined,
                preferredProviderId: provider.id,
                extraHeaders: variant.name
                  ? { 'X-InboxFlow-Template': variant.name.slice(0, 80) }
                  : undefined,
              });
              if (result.fromEmail) fromEmail = result.fromEmail;
              results.push({
                subject,
                fromName: slot.name.trim() || '(email only)',
                fromEmail: result.fromEmail || slot.email || undefined,
                providerName: provider.name,
                providerHost: cfg.host || null,
                templateId: variant.id,
                templateName: variant.name,
                success: result.success,
                messageId: result.messageId,
                smtpResponse: result.smtpResponse,
                error: result.error,
              });
            }
          }
        }
      }

      const sent = results.filter((r) => r.success).length;
      const firstProvider = providers[0]!;
      const firstCfg = parseProviderConfig(firstProvider.config);
      await writeSystemLog({
        organizationId: orgId,
        level: sent > 0 ? 'SUCCESS' : 'ERROR',
        category: 'smtp',
        message:
          sent > 0
            ? `Placement test sent via ${providers.length} SMTP(s) From ${fromEmail} → ${body.to}`
            : `Placement test failed via ${firstProvider.name} (${firstCfg.host || firstProvider.type}) From ${fromEmail} → ${body.to}: ${results[0]?.error || 'send failed'}`,
        meta: {
          campaignId: id,
          providerIds: providers.map((p) => p.id),
          fromEmail,
          to: body.to,
          results,
        },
      });

      return reply.send({
        success: results.every((r) => r.success),
        sent,
        total: results.length,
        providerName: firstProvider.name,
        providerHost: firstCfg.host || null,
        fromEmail,
        results,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/export-config', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      return reply.send({
        version: 1,
        exportedAt: new Date().toISOString(),
        campaign: {
          name: campaign.name,
          subject: campaign.subject,
          previewText: campaign.previewText,
          senderName: campaign.senderName,
          senderEmail: campaign.senderEmail,
          replyTo: campaign.replyTo,
          htmlContent: campaign.htmlContent,
          plainTextContent: campaign.plainTextContent,
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
          queueSettings: campaign.queueSettings,
          subjectPool: campaign.subjectPool,
          fromNamePool: campaign.fromNamePool,
          templatePool: campaign.templatePool,
          utmSource: campaign.utmSource,
          utmMedium: campaign.utmMedium,
          utmCampaign: campaign.utmCampaign,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      if (campaign.status === 'SENDING') {
        throw new AppError(400, 'Cancel the send first, then delete this campaign');
      }

      await drainCampaignJobs(id);
      const { getCampaignLiveStats } = await import('../../services/campaigns/live-stats.js');
      const { addOrgLifetimeStats } = await import('../../services/org-lifetime-stats.js');
      const live = await getCampaignLiveStats(id, campaign.totalRecipients);
      await addOrgLifetimeStats(orgId, {
        sent: Math.max(live.sentCount, campaign.sentCount),
        delivered: Math.max(live.deliveredCount, campaign.deliveredCount, live.sentCount, campaign.sentCount),
        failed: Math.max(live.failedCount, campaign.failedCount),
        opened: Math.max(live.openedCount, campaign.openedCount),
        clicked: Math.max(live.clickedCount, campaign.clickedCount),
        bounced: Math.max(live.bouncedCount, campaign.bouncedCount),
        complained: campaign.complainedCount,
      });
      await prisma.$transaction([
        prisma.dripStep.updateMany({ where: { campaignId: id }, data: { campaignId: null } }),
        prisma.campaign.delete({ where: { id } }),
      ]);

      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/duplicate', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z.object({ asResendDraft: z.boolean().optional() }).parse(request.body ?? {});
      const source = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!source) throw new AppError(404, 'Campaign not found');
      const name = body.asResendDraft
        ? await nextResendName(orgId, source.name)
        : `${campaignBaseName(source.name)} (Copy)`;

      const data: Prisma.CampaignCreateInput = {
        organization: { connect: { id: orgId } },
        createdBy: request.user.id ? { connect: { id: request.user.id } } : undefined,
        name,
        type: source.type,
        subject: source.subject,
        previewText: source.previewText,
        senderName: source.senderName,
        senderEmail: source.senderEmail,
        replyTo: source.replyTo,
        htmlContent: source.htmlContent,
        plainTextContent: source.plainTextContent,
        editorJson: (source.editorJson as Prisma.InputJsonValue) ?? undefined,
        list: source.listId ? { connect: { id: source.listId } } : undefined,
        segment: source.segmentId ? { connect: { id: source.segmentId } } : undefined,
        template: source.templateId ? { connect: { id: source.templateId } } : undefined,
        provider: source.providerId ? { connect: { id: source.providerId } } : undefined,
        templatePool: (source.templatePool as Prisma.InputJsonValue) ?? undefined,
        subjectPool: (source.subjectPool as Prisma.InputJsonValue) ?? undefined,
        fromNamePool: (source.fromNamePool as Prisma.InputJsonValue) ?? undefined,
        queueSettings: (source.queueSettings as Prisma.InputJsonValue) ?? undefined,
        trackOpens: source.trackOpens,
        trackClicks: source.trackClicks,
        ...(body.asResendDraft ? { utmCampaign: `resend-${id.slice(-8)}` } : {}),
        status: 'DRAFT',
      };
      let campaign;
      try {
        campaign = await prisma.campaign.create({ data });
      } catch {
        campaign = await prisma.campaign.create({
          data: {
            organization: { connect: { id: orgId } },
            name,
            type: source.type,
            subject: source.subject,
            htmlContent: source.htmlContent,
            plainTextContent: source.plainTextContent,
            editorJson: (source.editorJson as Prisma.InputJsonValue) ?? undefined,
            trackOpens: source.trackOpens,
            trackClicks: source.trackClicks,
            status: 'DRAFT',
            ...(body.asResendDraft ? { utmCampaign: `resend-${id.slice(-8)}` } : {}),
          },
        });
      }
      return reply.status(201).send({ campaign });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
