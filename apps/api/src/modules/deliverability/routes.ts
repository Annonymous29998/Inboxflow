import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { analyzeCampaign, analyzeSubjectLine } from './analyzer.js';
import { scrubCampaignContent } from './spam-scrubber.js';
import { authenticate } from '../../middleware/auth.js';

const analyzeSchema = z.object({
  subject: z.string().optional().nullable(),
  previewText: z.string().optional().nullable(),
  htmlContent: z.string().optional().nullable(),
  plainTextContent: z.string().optional().nullable(),
  senderName: z.string().optional().nullable(),
  senderEmail: z.string().optional().nullable(),
  campaignId: z.string().optional(),
  domainId: z.string().optional(),
});

export async function deliverabilityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/analyze', async (request, reply) => {
    try {
      const body = analyzeSchema.parse(request.body);
      const orgId = request.user.organizationId;
      if (!orgId) throw new AppError(400, 'No organization');

      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      let authStatus = { spf: false, dkim: false, dmarc: false, bimi: false };

      if (body.domainId) {
        const domain = await prisma.domain.findFirst({
          where: { id: body.domainId, organizationId: orgId },
        });
        if (domain) {
          authStatus = {
            spf: domain.spfValid,
            dkim: domain.dkimValid,
            dmarc: domain.dmarcValid,
            bimi: domain.bimiValid,
          };
        }
      } else {
        const domain = await prisma.domain.findFirst({
          where: { organizationId: orgId, status: 'VERIFIED' },
        });
        if (domain) {
          authStatus = {
            spf: domain.spfValid,
            dkim: domain.dkimValid,
            dmarc: domain.dmarcValid,
            bimi: domain.bimiValid,
          };
        }
      }

      let input = { ...body, physicalAddress: org?.physicalAddress, authStatus };

      if (body.campaignId) {
        const campaign = await prisma.campaign.findFirst({
          where: { id: body.campaignId, organizationId: orgId },
        });
        if (!campaign) throw new AppError(404, 'Campaign not found');
        input = {
          subject: body.subject ?? campaign.subject,
          previewText: body.previewText ?? campaign.previewText,
          htmlContent: body.htmlContent ?? campaign.htmlContent,
          plainTextContent: body.plainTextContent ?? campaign.plainTextContent,
          senderName: body.senderName ?? campaign.senderName,
          senderEmail: body.senderEmail ?? campaign.senderEmail,
          physicalAddress: org?.physicalAddress,
          authStatus,
        };

        const report = analyzeCampaign(input);
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: {
            deliverabilityScore: report.score,
            inboxReadinessScore: report.inboxReadiness.overall,
            analysisReport: report as object,
            status: campaign.status === 'DRAFT' ? 'ANALYZING' : campaign.status,
          },
        });
        if (campaign.status === 'DRAFT' || campaign.status === 'ANALYZING') {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: report.rating === 'high_risk' ? 'DRAFT' : 'READY' },
          });
        }
        return reply.send({ report });
      }

      const report = analyzeCampaign(input);
      return reply.send({ report });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/subject', async (request, reply) => {
    try {
      const body = z.object({ subject: z.string() }).parse(request.body);
      return reply.send({ analysis: analyzeSubjectLine(body.subject) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/scrub', async (request, reply) => {
    try {
      const body = z
        .object({
          subject: z.string().optional().nullable(),
          previewText: z.string().optional().nullable(),
          htmlContent: z.string().optional().nullable(),
          plainTextContent: z.string().optional().nullable(),
          campaignId: z.string().optional(),
          persist: z.boolean().default(false),
        })
        .parse(request.body ?? {});

      const orgId = request.user.organizationId;
      if (!orgId) throw new AppError(400, 'No organization');

      let input = {
        subject: body.subject,
        previewText: body.previewText,
        htmlContent: body.htmlContent,
        plainTextContent: body.plainTextContent,
      };

      if (body.campaignId) {
        const campaign = await prisma.campaign.findFirst({
          where: { id: body.campaignId, organizationId: orgId },
        });
        if (!campaign) throw new AppError(404, 'Campaign not found');
        input = {
          subject: body.subject ?? campaign.subject,
          previewText: body.previewText ?? campaign.previewText,
          htmlContent: body.htmlContent ?? campaign.htmlContent,
          plainTextContent: body.plainTextContent ?? campaign.plainTextContent,
        };
      }

      const scrubbed = scrubCampaignContent(input);

      if (body.persist && body.campaignId) {
        await prisma.campaign.update({
          where: { id: body.campaignId },
          data: {
            subject: scrubbed.subject,
            previewText: scrubbed.previewText,
            htmlContent: scrubbed.htmlContent,
            plainTextContent: scrubbed.plainTextContent,
            status: 'DRAFT',
          },
        });
      }

      return reply.send({ scrubbed });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
