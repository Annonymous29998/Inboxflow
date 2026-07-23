import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { drainCampaignJobs, enqueueCampaign, enqueueCampaignScheduled } from '../../services/email/queue.js';
import { sendCampaignEmailToRecipient } from '../../services/email/campaign-send.js';
import { analyzeCampaign } from '../deliverability/analyzer.js';
import { scrubCampaignContent, findRemainingSpamPhrases } from '../deliverability/spam-scrubber.js';

type SegmentRules = {
  conditions?: Array<{ field: string; operator: string; value: string }>;
  match?: 'all' | 'any';
};

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

async function collectCampaignContacts(campaign: {
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

      const [campaigns, total] = await Promise.all([
        prisma.campaign.findMany({
          where,
          orderBy: { updatedAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            list: { select: { id: true, name: true } },
            createdBy: { select: { id: true, firstName: true, lastName: true } },
          },
        }),
        prisma.campaign.count({ where }),
      ]);

      return reply.send({ campaigns, total, page, limit });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          name: z.string().min(1),
          type: z.enum(['REGULAR', 'SCHEDULED', 'AUTOMATED', 'DRIP']).default('REGULAR'),
          subject: z.string().optional(),
          previewText: z.string().optional(),
          senderName: z.string().optional(),
          senderEmail: z.string().email().optional().or(z.literal('')),
          replyTo: z.string().email().optional().or(z.literal('')),
          listId: z.string().optional(),
          segmentId: z.string().optional(),
          templateId: z.string().optional(),
          providerId: z.string().optional(),
          trackOpens: z.boolean().default(true),
          trackClicks: z.boolean().default(true),
          utmSource: z.string().optional(),
          utmMedium: z.string().optional(),
          utmCampaign: z.string().optional(),
        })
        .parse(request.body);

      const campaign = await prisma.campaign.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: body.name,
          type: body.type,
          subject: body.subject,
          previewText: body.previewText,
          senderName: body.senderName,
          senderEmail: body.senderEmail || null,
          replyTo: body.replyTo || null,
          listId: body.listId,
          segmentId: body.segmentId,
          templateId: body.templateId,
          providerId: body.providerId,
          trackOpens: body.trackOpens,
          trackClicks: body.trackClicks,
          utmSource: body.utmSource,
          utmMedium: body.utmMedium,
          utmCampaign: body.utmCampaign,
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
          recipients: {
            take: 500,
            orderBy: { createdAt: 'asc' },
            include: {
              contact: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          },
        },
      });
      if (!campaign) throw new AppError(404, 'Campaign not found');
      return reply.send({ campaign });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/send-status', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const [sentCount, failedCount, pendingCount] = await Promise.all([
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'SENT' } }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'FAILED' } }),
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'QUEUED' } }),
      ]);

      return reply.send({
        success: true,
        status: campaign.status,
        totalRecipients: campaign.totalRecipients,
        sentCount,
        failedCount,
        pendingCount,
        completedAt: campaign.completedAt,
      });
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
              batchSize: z.number().min(1).max(100).optional(),
              batchPauseMs: z.number().min(0).max(120_000).optional(),
              betweenEmailMs: z.number().min(0).max(10_000).optional(),
              maxConcurrent: z.number().min(1).max(20).optional(),
              maxPerMinute: z.number().min(1).max(600).optional(),
              maxPerHour: z.number().min(1).max(50_000).optional(),
            })
            .optional()
            .nullable(),
        })
        .parse(request.body);

      const existing = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!existing) throw new AppError(404, 'Campaign not found');
      if (['SENDING', 'SENT'].includes(existing.status)) {
        throw new AppError(400, 'Cannot edit a campaign that is sending or sent');
      }

      const campaign = await prisma.campaign.update({
        where: { id },
        data: {
          ...body,
          editorJson: body.editorJson as object | undefined,
          queueSettings: body.queueSettings === undefined ? undefined : (body.queueSettings as object),
          scheduledAt: body.scheduledAt
            ? new Date(body.scheduledAt)
            : body.scheduledAt === null
              ? null
              : undefined,
          status: 'DRAFT',
        },
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

      const recipients = await Promise.all(
        contacts.map((contact) =>
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

      await prisma.campaign.update({
        where: { id },
        data: {
          status: 'SENDING',
          sentAt: new Date(),
          sentCount: 0,
          totalRecipients: contacts.length,
          deliverabilityScore: report.score,
          analysisReport: report as object,
          providerId: body.providerId === undefined ? campaign.providerId : body.providerId,
        },
      });

      return reply.send({
        success: true,
        report,
        recipients: recipients.map((r, i) => ({
          id: r.id,
          contactId: contacts[i].id,
          email: contacts[i].email,
          displayName:
            [contacts[i].firstName, contacts[i].lastName].filter(Boolean).join(' ') ||
            contacts[i].email.split('@')[0],
        })),
      });
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
        })
        .parse(request.body);

      const campaign = await prisma.campaign.findFirst({
        where: { id, organizationId: orgId },
        select: { id: true, status: true, providerId: true },
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
      });

      if (!result.success) {
        return reply.status(400).send({ success: false, error: result.error });
      }

      return reply.send({ success: true, messageId: result.messageId });
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
        })
        .parse(request.body ?? {});

      const campaign = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!campaign) throw new AppError(404, 'Campaign not found');

      const [sentCount, failedCount, pendingCount] = await Promise.all([
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'SENT' } }),
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
          completedAt: status === 'SENT' || status === 'CANCELLED' ? new Date() : null,
        },
      });

      return reply.send({ campaign: updated, sentCount, failedCount, pendingCount });
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

      await prisma.campaign.update({
        where: { id },
        data: {
          status: 'READY',
          deliverabilityScore: report.score,
          analysisReport: report as object,
        },
      });
      await enqueueCampaign(id);
      return reply.send({ success: true, status: 'SENDING', mode: 'queue', report });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/pause', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.campaign.updateMany({
        where: { id, organizationId: orgId, status: 'SENDING' },
        data: { status: 'PAUSED' },
      });
      await drainCampaignJobs(id);
      const { writeSystemLog } = await import('../../services/system-log.js');
      await writeSystemLog({
        organizationId: orgId,
        level: 'WARNING',
        category: 'queue',
        message: `Campaign paused: ${id}`,
      });
      return reply.send({ success: true });
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
      const queued = await prisma.campaignRecipient.findMany({
        where: { campaignId: id, status: 'QUEUED' },
        include: { contact: true },
      });
      return reply.send({
        success: true,
        recipients: queued.map((r) => ({
          id: r.id,
          contactId: r.contactId,
          email: r.contact.email,
          displayName:
            [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') ||
            r.contact.email.split('@')[0],
        })),
        queueSettings: campaign.queueSettings,
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

      await prisma.campaignRecipient.updateMany({
        where: { campaignId: id, status: 'FAILED' },
        data: { status: 'QUEUED', error: null, messageId: null, sentAt: null },
      });
      await prisma.campaign.update({ where: { id }, data: { status: 'SENDING' } });

      const recipients = await prisma.campaignRecipient.findMany({
        where: { campaignId: id, status: 'QUEUED' },
        include: { contact: true },
      });

      return reply.send({
        success: true,
        recipients: recipients.map((r) => ({
          id: r.id,
          contactId: r.contactId,
          email: r.contact.email,
          displayName:
            [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') ||
            r.contact.email.split('@')[0],
        })),
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
        prisma.campaignRecipient.count({ where: { campaignId: id, status: 'SENT' } }),
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
        where: { id, organizationId: orgId, status: { in: ['SENDING', 'PAUSED', 'READY', 'SCHEDULED'] } },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
      await drainCampaignJobs(id);
      return reply.send({ success: true });
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
      const source = await prisma.campaign.findFirst({ where: { id, organizationId: orgId } });
      if (!source) throw new AppError(404, 'Campaign not found');

      const campaign = await prisma.campaign.create({
        data: {
          organizationId: orgId,
          createdById: request.user.id,
          name: `${source.name} (Copy)`,
          type: source.type,
          subject: source.subject,
          previewText: source.previewText,
          senderName: source.senderName,
          senderEmail: source.senderEmail,
          replyTo: source.replyTo,
          htmlContent: source.htmlContent,
          plainTextContent: source.plainTextContent,
          editorJson: source.editorJson ?? undefined,
          listId: source.listId,
          segmentId: source.segmentId,
          templateId: source.templateId,
          providerId: source.providerId,
          trackOpens: source.trackOpens,
          trackClicks: source.trackClicks,
          status: 'DRAFT',
        },
      });
      return reply.status(201).send({ campaign });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function requireOrg(orgId: string | null): string {
  if (!orgId) throw new AppError(400, 'No organization');
  return orgId;
}
