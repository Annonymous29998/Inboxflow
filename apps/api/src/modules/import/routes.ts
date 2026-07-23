import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';
import { writeSystemLog } from '../../services/system-log.js';

const UNSUPPORTED = [
  { pattern: /<script[\s>]/i, message: 'JavaScript <script> tags are unsupported in most email clients' },
  { pattern: /position:\s*fixed/i, message: 'position:fixed often breaks in email clients' },
  { pattern: /display:\s*flex/i, message: 'Flexbox has limited email support — prefer tables' },
  { pattern: /display:\s*grid/i, message: 'CSS Grid is poorly supported in email' },
  { pattern: /<iframe/i, message: 'iframes are blocked by email clients' },
  { pattern: /<form/i, message: 'Forms are often stripped; use links/buttons instead' },
  { pattern: /@import/i, message: '@import CSS is unreliable in email' },
  { pattern: /<video/i, message: 'Video tags are unsupported — use a thumbnail + link' },
];

function htmlToPlainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validateEmailHtml(html: string) {
  const warnings: string[] = [];
  const flags: string[] = [];
  for (const item of UNSUPPORTED) {
    if (item.pattern.test(html)) flags.push(item.message);
  }
  if (!/<a\s/i.test(html) && /http/i.test(html)) {
    warnings.push('URLs found without anchors — wrap links in <a href="">');
  }
  if (!/unsubscribe/i.test(html)) {
    warnings.push('No unsubscribe mention detected — required for compliance');
  }
  if ((html.match(/<img/gi) || []).length > 15) {
    warnings.push('High image count can hurt deliverability and load time');
  }
  if (html.length > 1024 * 120) {
    warnings.push('HTML is large (>120KB) — some clients clip or throttle');
  }
  return { warnings, flags };
}

function extractImageSrcs(html: string) {
  const srcs: string[] = [];
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) srcs.push(m[1]);
  return [...new Set(srcs)];
}

/** Very small MJML → HTML fallback for simple templates (full MJML compiler optional). */
function mjmlToHtmlLite(mjml: string) {
  if (!/<mjml/i.test(mjml)) return mjml;
  const text = mjml
    .replace(/<\/?mjml[^>]*>/gi, '')
    .replace(/<\/?mj-body[^>]*>/gi, '')
    .replace(/<\/?mj-section[^>]*>/gi, '<div style="padding:8px 0">')
    .replace(/<\/mj-section>/gi, '</div>')
    .replace(/<\/?mj-column[^>]*>/gi, '<div>')
    .replace(/<\/mj-column>/gi, '</div>')
    .replace(/<mj-text[^>]*>/gi, '<p style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5">')
    .replace(/<\/mj-text>/gi, '</p>')
    .replace(/<mj-button[^>]*href=["']([^"']+)["'][^>]*>/gi, '<p><a href="$1" style="background:#111;color:#fff;padding:12px 20px;text-decoration:none;display:inline-block">')
    .replace(/<\/mj-button>/gi, '</a></p>')
    .replace(/<mj-image[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, '<img src="$1" style="max-width:100%" />')
    .replace(/<\/?mj-[a-z0-9-]+[^>]*>/gi, '');
  return `<!DOCTYPE html><html><body style="margin:0;background:#f4f4f4;padding:24px">${text}</body></html>`;
}

export async function importRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/html', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          filename: z.string().optional(),
          content: z.string().min(1),
          format: z.enum(['html', 'mjml', 'zip-entry']).default('html'),
          campaignId: z.string().optional(),
          name: z.string().optional(),
          /** Save imported HTML to the template library (default true). */
          saveAsTemplate: z.boolean().default(true),
          templateName: z.string().optional(),
        })
        .parse(request.body);

      let html = body.content;
      if (body.format === 'mjml' || body.filename?.endsWith('.mjml')) {
        html = mjmlToHtmlLite(body.content);
      }

      // Fix relative image paths to absolute placeholders when needed
      const images = extractImageSrcs(html);
      const relativeImages = images.filter((src) => !/^https?:\/\//i.test(src) && !src.startsWith('data:'));
      for (const src of relativeImages) {
        const fixed = src.startsWith('/')
          ? `https://inboxflow.io${src}`
          : `https://inboxflow.io/assets/${src.replace(/^\.\//, '')}`;
        html = html.split(src).join(fixed);
      }

      const plainText = htmlToPlainText(html);
      const validation = validateEmailHtml(html);

      const templateName =
        body.templateName?.trim() ||
        body.name?.trim() ||
        body.filename?.replace(/\.(html|htm|mjml|txt)$/i, '').trim() ||
        'Imported template';

      let template = null;
      if (body.saveAsTemplate) {
        template = await prisma.template.create({
          data: {
            organizationId: orgId,
            createdById: request.user.id,
            name: templateName,
            description: body.filename ? `Imported from ${body.filename}` : 'Imported HTML template',
            htmlContent: html,
            plainText,
            editorJson: { blocks: [{ id: 'imported', type: 'html', content: html }] },
            mjmlSource: body.format === 'mjml' ? body.content : undefined,
          },
        });
      }

      let campaign = null;
      if (body.campaignId) {
        const existing = await prisma.campaign.findFirst({
          where: { id: body.campaignId, organizationId: orgId },
        });
        if (!existing) throw new AppError(404, 'Campaign not found');
        campaign = await prisma.campaign.update({
          where: { id: body.campaignId },
          data: {
            htmlContent: html,
            plainTextContent: plainText,
            name: body.name || existing.name,
            status: 'DRAFT',
            templateId: template?.id ?? existing.templateId,
            editorJson: { blocks: [{ id: 'imported', type: 'html', content: html }] },
          },
        });
      }

      await writeSystemLog({
        organizationId: orgId,
        level: validation.flags.length ? 'WARNING' : 'SUCCESS',
        category: 'campaign',
        message: `Imported HTML template${body.filename ? `: ${body.filename}` : ''}`,
        meta: {
          images: images.length,
          relativeFixed: relativeImages.length,
          flags: validation.flags.length,
        },
      });

      return reply.send({
        html,
        plainText,
        template,
        images: {
          total: images.length,
          relativeFixed: relativeImages,
          remote: images.filter((s) => /^https?:\/\//i.test(s)),
        },
        validation,
        campaign,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
