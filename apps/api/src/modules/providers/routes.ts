import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { AppError, sendError } from '../../utils/errors.js';
import { requireOrg } from '../../utils/org.js';
import { authenticate } from '../../middleware/auth.js';
import { encrypt } from '../../utils/crypto.js';
import {
  parseProviderConfig,
  sendSmtpTestEmail,
  testProviderConnection,
  testSmtpConnection,
} from '../../services/email/providers.js';
import { migrateLegacySmtpBranding, removeEnvBootstrappedSmtpProviders } from '../../services/email/migrate-legacy-smtp.js';
import { detectSmtpConfigIssues, writeSystemLog } from '../../services/system-log.js';
import { isBlockedSmtpHost } from '../../utils/signed-urls.js';

function normalizeConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  for (const key of ['secure', 'requireTLS', 'ignoreTLS']) {
    if (out[key] !== undefined) {
      out[key] = ['true', '1', 'yes', 'on'].includes(out[key].toLowerCase()) ? 'true' : 'false';
    }
  }
  // Map encryption enum → secure/requireTLS
  if (out.encryption) {
    const enc = out.encryption.toUpperCase();
    if (enc === 'SSL' || enc === 'TLS') {
      out.secure = 'true';
      out.requireTLS = 'false';
    } else if (enc === 'STARTTLS') {
      out.secure = 'false';
      out.requireTLS = 'true';
    }
  }
  return out;
}

function mapProvider(p: {
  id: string;
  name: string;
  label: string | null;
  type: string;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
  dailyLimit: number | null;
  hourlyLimit: number | null;
  notes: string | null;
  lastTestStatus: string | null;
  lastTestAt: Date | null;
  lastTestError: string | null;
  sentToday: number;
  createdAt: Date;
  updatedAt: Date;
  config: unknown;
}) {
  const config = parseProviderConfig(p.config);
  return {
    id: p.id,
    name: p.name,
    label: p.label,
    type: p.type,
    isDefault: p.isDefault,
    isActive: p.isActive,
    priority: p.priority,
    dailyLimit: p.dailyLimit,
    hourlyLimit: p.hourlyLimit,
    notes: p.notes,
    lastTestStatus: p.lastTestStatus || 'Pending',
    lastTestAt: p.lastTestAt,
    lastTestError: p.lastTestError,
    sentToday: p.sentToday,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    fromEmail: config.fromEmail || config.user || '',
    fromName: config.fromName || '',
    replyTo: config.replyTo || '',
    host: config.host || '',
    port: config.port || '',
    encryption: config.encryption || (config.secure === 'true' ? 'SSL' : 'STARTTLS'),
    user: config.user || '',
    issues: detectSmtpConfigIssues(config),
  };
}

export async function providerRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  const smtpConfigSchema = z.object({
    host: z.string().min(1),
    port: z.union([z.string(), z.number()]).optional(),
    secure: z.union([z.boolean(), z.string()]).optional(),
    encryption: z.string().optional(),
    user: z.string().optional(),
    pass: z.string().optional(),
    requireTLS: z.union([z.boolean(), z.string()]).optional(),
    ignoreTLS: z.union([z.boolean(), z.string()]).optional(),
    fromEmail: z.string().optional(),
    fromName: z.string().optional(),
    replyTo: z.string().optional(),
  });

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      await removeEnvBootstrappedSmtpProviders(orgId);
      await migrateLegacySmtpBranding(orgId);
      const providers = await prisma.emailProvider.findMany({
        where: { organizationId: orgId },
        orderBy: [{ isDefault: 'desc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      });
      return reply.send({ providers: providers.map(mapProvider) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const provider = await prisma.emailProvider.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!provider) throw new AppError(404, 'Provider not found');
      await migrateLegacySmtpBranding(orgId);
      const refreshed = await prisma.emailProvider.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!refreshed) throw new AppError(404, 'Provider not found');

      const config = parseProviderConfig(refreshed.config);
      const safeConfig = {
        ...config,
        pass: config.pass ? '••••••••' : '',
        apiKey: config.apiKey ? '••••••••' : '',
        serverToken: config.serverToken ? '••••••••' : '',
        secretAccessKey: config.secretAccessKey ? '••••••••' : '',
      };

      return reply.send({
        provider: {
          ...mapProvider(refreshed),
          config: safeConfig,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          name: z.string().min(1).optional(),
          label: z.string().optional().nullable(),
          type: z.enum(['SES', 'MAILGUN', 'POSTMARK', 'SENDGRID', 'SMTP']),
          config: z.record(z.string()),
          isDefault: z.boolean().default(false),
          isActive: z.boolean().default(false),
          dailyLimit: z.number().optional().nullable(),
          hourlyLimit: z.number().optional().nullable(),
          priority: z.number().default(0),
          notes: z.string().optional().nullable(),
        })
        .parse(request.body);

      if (body.type === 'SMTP') {
        const smtp = smtpConfigSchema.safeParse(body.config);
        if (!smtp.success) throw new AppError(400, 'SMTP requires at least a host');
        if (body.config.host && isBlockedSmtpHost(body.config.host)) {
          throw new AppError(400, 'SMTP host is not allowed');
        }
        // Disallow TLS verification bypass in production
        if (env.NODE_ENV === 'production' && ['true', '1', 'yes'].includes(String(body.config.ignoreTLS || '').toLowerCase())) {
          throw new AppError(400, 'ignoreTLS is not allowed in production');
        }
        const issues = detectSmtpConfigIssues(body.config);
        if (issues.length && body.isActive) {
          throw new AppError(400, `Fix SMTP issues before activating: ${issues[0]}`);
        }
      }

      const autoName =
        body.name?.trim() ||
        body.config.fromEmail ||
        body.config.user ||
        body.config.host ||
        `${body.type} provider`;

      // New profiles start Pending; active only after successful test (UI enforces; allow inactive save)
      if (body.isActive && body.type === 'SMTP') {
        throw new AppError(
          400,
          'Run Test Connection successfully before marking an SMTP profile as active',
        );
      }

      if (body.isDefault) {
        await prisma.emailProvider.updateMany({
          where: { organizationId: orgId },
          data: { isDefault: false },
        });
      }

      const provider = await prisma.emailProvider.create({
        data: {
          organizationId: orgId,
          name: autoName,
          label: body.label ?? null,
          type: body.type,
          config: { encrypted: encrypt(JSON.stringify(normalizeConfig(body.config))) },
          isDefault: body.isDefault,
          isActive: body.type === 'SMTP' ? false : body.isActive,
          dailyLimit: body.dailyLimit ?? undefined,
          hourlyLimit: body.hourlyLimit ?? undefined,
          priority: body.priority,
          notes: body.notes,
          lastTestStatus: 'Pending',
        },
      });

      await writeSystemLog({
        organizationId: orgId,
        level: 'INFO',
        category: 'smtp',
        message: `SMTP profile created: ${provider.name}`,
        meta: { providerId: provider.id },
      });

      return reply.status(201).send({ provider: mapProvider(provider) });
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
          name: z.string().min(1).optional(),
          label: z.string().nullable().optional(),
          isDefault: z.boolean().optional(),
          isActive: z.boolean().optional(),
          priority: z.number().optional(),
          dailyLimit: z.number().nullable().optional(),
          hourlyLimit: z.number().nullable().optional(),
          notes: z.string().nullable().optional(),
          config: z.record(z.string()).optional(),
        })
        .parse(request.body);

      const existing = await prisma.emailProvider.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!existing) throw new AppError(404, 'Provider not found');

      if (body.isActive === true && existing.type === 'SMTP' && existing.lastTestStatus !== 'Connected') {
        throw new AppError(400, 'Test Connection must succeed (Connected) before activating');
      }

      if (body.isDefault) {
        await prisma.emailProvider.updateMany({
          where: { organizationId: orgId },
          data: { isDefault: false },
        });
      }

      let nextConfig = existing.config;
      if (body.config) {
        const current = parseProviderConfig(existing.config);
        const merged = { ...current };
        for (const [key, value] of Object.entries(body.config)) {
          if (value === '••••••••') continue;
          if (value === '' && ['pass', 'apiKey', 'serverToken', 'secretAccessKey'].includes(key) && current[key]) {
            continue;
          }
          merged[key] = value;
        }
        nextConfig = { encrypted: encrypt(JSON.stringify(normalizeConfig(merged))) };
      }

      const provider = await prisma.emailProvider.update({
        where: { id },
        data: {
          name: body.name,
          label: body.label === undefined ? undefined : body.label,
          isDefault: body.isDefault,
          isActive: body.isActive,
          priority: body.priority,
          dailyLimit: body.dailyLimit === null ? null : body.dailyLimit,
          hourlyLimit: body.hourlyLimit === null ? null : body.hourlyLimit,
          notes: body.notes === undefined ? undefined : body.notes,
          config: nextConfig as object,
        },
      });

      return reply.send({ provider: mapProvider(provider) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const existing = await prisma.emailProvider.findFirst({ where: { id, organizationId: orgId } });
      if (!existing) throw new AppError(404, 'Provider not found');
      await prisma.emailProvider.delete({ where: { id } });
      await writeSystemLog({
        organizationId: orgId,
        level: 'WARNING',
        category: 'smtp',
        message: `SMTP profile deleted: ${existing.name}`,
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/test', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z
        .object({
          type: z.enum(['SES', 'MAILGUN', 'POSTMARK', 'SENDGRID', 'SMTP']).default('SMTP'),
          config: z.record(z.union([z.string(), z.number(), z.boolean()])),
          sendTestEmail: z.boolean().default(false),
          testEmailTo: z.string().email().optional(),
          notes: z.string().optional().nullable(),
        })
        .parse(request.body);

      const config = Object.fromEntries(
        Object.entries(body.config).map(([k, v]) => [k, String(v)]),
      );
      if (body.type === 'SMTP' && config.host && isBlockedSmtpHost(config.host)) {
        throw new AppError(400, 'SMTP host is not allowed');
      }
      if (
        env.NODE_ENV === 'production' &&
        ['true', '1', 'yes'].includes(String(config.ignoreTLS || '').toLowerCase())
      ) {
        throw new AppError(400, 'ignoreTLS is not allowed in production');
      }
      const issues = body.type === 'SMTP' ? detectSmtpConfigIssues(config) : [];

      let result;
      if (body.type === 'SMTP' && body.sendTestEmail) {
        if (!body.testEmailTo) throw new AppError(400, 'testEmailTo is required when sendTestEmail is true');
        result = await sendSmtpTestEmail(config, body.testEmailTo, { notes: body.notes });
      } else {
        result =
          body.type === 'SMTP'
            ? await testSmtpConnection(config)
            : await testProviderConnection(body.type, config);
      }

      await writeSystemLog({
        organizationId: orgId,
        level: result.success ? 'SUCCESS' : 'ERROR',
        category: 'smtp',
        message: result.success
          ? `SMTP test OK: ${config.host || body.type}`
          : `SMTP test failed: ${result.error || result.message}`,
        meta: { issues },
      });

      return reply.send({ result, issues });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/test', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          sendTestEmail: z.boolean().default(false),
          testEmailTo: z.string().email().optional(),
          notes: z.string().optional().nullable(),
          config: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        })
        .parse(request.body ?? {});

      const provider = await prisma.emailProvider.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!provider) throw new AppError(404, 'Provider not found');

      await prisma.emailProvider.update({
        where: { id },
        data: { lastTestStatus: 'Pending', lastTestError: null },
      });

      const stored = parseProviderConfig(provider.config);
      const overrides = body.config
        ? Object.fromEntries(Object.entries(body.config).map(([k, v]) => [k, String(v)]))
        : {};
      const config = { ...stored };
      for (const [key, value] of Object.entries(overrides)) {
        if (value === '••••••••') continue;
        if (!value && ['pass', 'apiKey', 'serverToken', 'secretAccessKey'].includes(key)) continue;
        config[key] = value;
      }

      const issues = provider.type === 'SMTP' ? detectSmtpConfigIssues(config) : [];

      let result;
      if (provider.type === 'SMTP' && body.sendTestEmail) {
        if (!body.testEmailTo) throw new AppError(400, 'testEmailTo is required when sendTestEmail is true');
        result = await sendSmtpTestEmail(config, body.testEmailTo, {
          notes: body.notes ?? (typeof provider.notes === 'string' ? provider.notes : null),
        });
      } else {
        result = await testProviderConnection(provider.type, config);
      }

      const updated = await prisma.emailProvider.update({
        where: { id },
        data: {
          lastTestStatus: result.success ? 'Connected' : 'Failed',
          lastTestAt: new Date(),
          lastTestError: result.success ? null : result.error || result.message,
          isActive: result.success ? provider.isActive : false,
        },
      });

      await writeSystemLog({
        organizationId: orgId,
        level: result.success ? 'SUCCESS' : 'ERROR',
        category: 'smtp',
        message: result.success
          ? `Connected to SMTP: ${provider.name}`
          : `Authentication failed: ${provider.name} — ${result.error || result.message}`,
        meta: { providerId: id, issues },
      });

      return reply.send({ result, issues, provider: mapProvider(updated) });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
