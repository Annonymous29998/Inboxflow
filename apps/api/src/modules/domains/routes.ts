import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPublicKey, generateKeyPairSync } from 'crypto';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { encrypt, generateToken } from '../../utils/crypto.js';
import {
  INBOXFLOW_SMTP_DAILY_LIMIT,
  INBOXFLOW_SMTP_HOSTNAME,
  INBOXFLOW_SMTP_LISTEN_PORT,
} from '../../services/email/inboxflow-smtp.js';
import { requireOrg } from '../../utils/org.js';
import { recommendedSpfForHosts } from '../deliverability/smtp-auth-hints.js';
import { orgSmtpHosts, verifyOrganizationDomain } from './domain-dns.js';

function pemToDkimPublicKey(privateKeyPem: string): string {
  const pub = createPublicKey(privateKeyPem);
  const pubPem = pub.export({ type: 'spki', format: 'pem' }) as string;
  return pubPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
}

export async function domainRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const domains = await prisma.domain.findMany({
        where: { organizationId: orgId },
        include: { dnsRecords: true, smtpCredentials: true },
        orderBy: { createdAt: 'desc' },
      });
      const smtpHosts = await orgSmtpHosts(orgId);
      return reply.send({
        smtpHosts,
        domains: domains.map((d) => ({
          ...d,
          dkimPrivateKeyEnc: undefined,
          hasDkimPrivateKey: Boolean(d.dkimPrivateKeyEnc),
          dkimSelector: d.dkimSelector,
          smtpCredentials: d.smtpCredentials.map((c) => ({
            id: c.id,
            username: c.username,
            host: c.host,
            port: c.port,
            encryption: c.encryption,
            dailyLimit: c.dailyLimit,
            sentToday: c.sentDay === new Date().toISOString().slice(0, 10) ? c.sentToday : 0,
            isActive: c.isActive,
            createdAt: c.createdAt,
          })),
        })),
        smtp: {
          host: INBOXFLOW_SMTP_HOSTNAME,
          port: INBOXFLOW_SMTP_LISTEN_PORT,
          encryption: 'STARTTLS',
          dailyLimit: INBOXFLOW_SMTP_DAILY_LIMIT,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const body = z.object({ domain: z.string().min(3) }).parse(request.body);
      const domainName = body.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

      const existing = await prisma.domain.findUnique({
        where: { organizationId_domain: { organizationId: orgId, domain: domainName } },
      });
      if (existing) throw new AppError(409, 'Domain already added');

      const dkimSelector = 'inboxflow';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const publicB64 = publicKey
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');
      const dkimValue = `v=DKIM1; k=rsa; p=${publicB64}`;
      const verificationToken = generateToken(16);
      const smtpHosts = await orgSmtpHosts(orgId);
      const spf = recommendedSpfForHosts(smtpHosts);

      const domain = await prisma.domain.create({
        data: {
          organizationId: orgId,
          domain: domainName,
          trackingDomain: `track.${domainName}`,
          returnPath: `bounce.${domainName}`,
          dkimSelector,
          dkimPrivateKeyEnc: encrypt(privateKey),
          dnsRecords: {
            create: [
              {
                type: 'SPF',
                host: '@',
                value: spf.record,
              },
              {
                type: 'DKIM',
                host: `${dkimSelector}._domainkey`,
                value: dkimValue,
              },
              {
                type: 'DMARC',
                host: '_dmarc',
                value: `v=DMARC1; p=none; rua=mailto:dmarc@${domainName}; pct=100`,
              },
              {
                type: 'TRACKING',
                host: 'track',
                value: 'track.inboxflow.io',
              },
              {
                type: 'RETURN_PATH',
                host: 'bounce',
                value: 'bounce.inboxflow.io',
              },
              {
                type: 'CUSTOM',
                host: '_inboxflow-verify',
                value: verificationToken,
              },
            ],
          },
        },
        include: { dnsRecords: true },
      });

      return reply.status(201).send({
        domain: {
          ...domain,
          dkimPrivateKeyEnc: undefined,
          hasDkimPrivateKey: true,
        },
        instructions: getSetupInstructions(domainName, domain.dnsRecords, smtpHosts),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  /** Upload or replace optional app-side DKIM signing key (advanced). */
  app.post('/:id/dkim', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const body = z
        .object({
          selector: z.string().min(1).max(63).default('inboxflow'),
          privateKeyPem: z.string().min(32).optional(),
          generate: z.boolean().optional(),
        })
        .parse(request.body);

      const domain = await prisma.domain.findFirst({
        where: { id, organizationId: orgId },
        include: { dnsRecords: true },
      });
      if (!domain) throw new AppError(404, 'Domain not found');

      let privateKey = body.privateKeyPem?.trim();
      if (body.generate || !privateKey) {
        const pair = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        privateKey = pair.privateKey;
      }

      let publicB64: string;
      try {
        publicB64 = pemToDkimPublicKey(privateKey);
      } catch {
        throw new AppError(400, 'Invalid RSA private key PEM');
      }

      const dkimValue = `v=DKIM1; k=rsa; p=${publicB64}`;
      const host = `${body.selector}._domainkey`;

      const existingDkim = domain.dnsRecords.find((r) => r.type === 'DKIM');
      if (existingDkim) {
        await prisma.dnsRecord.update({
          where: { id: existingDkim.id },
          data: { host, value: dkimValue, status: 'PENDING' },
        });
      } else {
        await prisma.dnsRecord.create({
          data: { domainId: id, type: 'DKIM', host, value: dkimValue },
        });
      }

      const updated = await prisma.domain.update({
        where: { id },
        data: {
          dkimSelector: body.selector,
          dkimPrivateKeyEnc: encrypt(privateKey),
        },
        include: { dnsRecords: true },
      });

      return reply.send({
        success: true,
        domain: {
          ...updated,
          dkimPrivateKeyEnc: undefined,
          hasDkimPrivateKey: true,
        },
        dnsRecord: {
          host,
          value: dkimValue,
          type: 'TXT',
        },
        note: 'Publish the DKIM TXT record, then Verify. Outbound SMTP sends will sign when this key is stored.',
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id/dkim', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const domain = await prisma.domain.findFirst({ where: { id, organizationId: orgId } });
      if (!domain) throw new AppError(404, 'Domain not found');
      await prisma.domain.update({
        where: { id },
        data: { dkimPrivateKeyEnc: null, dkimSelector: null },
      });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/verify', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const checked = await verifyOrganizationDomain(orgId, id);
      if (!checked) throw new AppError(404, 'Domain not found');

      return reply.send({
        domain: checked.domain,
        results: checked.results,
        instructions: getSetupInstructions(checked.domain.domain, checked.domain.dnsRecords, checked.smtpHosts),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/instructions', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const domain = await prisma.domain.findFirst({
        where: { id, organizationId: orgId },
        include: { dnsRecords: true },
      });
      if (!domain) throw new AppError(404, 'Domain not found');
      const smtpHosts = await orgSmtpHosts(orgId);
      return reply.send({
        instructions: getSetupInstructions(domain.domain, domain.dnsRecords, smtpHosts),
        domain,
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get('/:id/smtp-credentials', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const domain = await prisma.domain.findFirst({
        where: { id, organizationId: orgId },
        include: { smtpCredentials: { orderBy: { createdAt: 'desc' } } },
      });
      if (!domain) throw new AppError(404, 'Domain not found');
      return reply.send({
        host: INBOXFLOW_SMTP_HOSTNAME,
        port: INBOXFLOW_SMTP_LISTEN_PORT,
        encryption: 'STARTTLS',
        dailyLimit: INBOXFLOW_SMTP_DAILY_LIMIT,
        credentials: domain.smtpCredentials.map((c) => ({
          id: c.id,
          username: c.username,
          host: c.host,
          port: c.port,
          encryption: c.encryption,
          dailyLimit: c.dailyLimit,
          sentToday: c.sentDay === new Date().toISOString().slice(0, 10) ? c.sentToday : 0,
          isActive: c.isActive,
          createdAt: c.createdAt,
          lastUsedAt: c.lastUsedAt,
        })),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post('/:id/smtp-credentials', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const domain = await prisma.domain.findFirst({
        where: { id, organizationId: orgId },
      });
      if (!domain) throw new AppError(404, 'Domain not found');
      if (domain.status !== 'VERIFIED') {
        throw new AppError(400, 'Verify SPF, DKIM, and DMARC before generating SMTP credentials');
      }

      const password = generateToken(18);
      const username = `if.${domain.domain.replace(/[^a-z0-9.-]/gi, '')}.${generateToken(4)}@${INBOXFLOW_SMTP_HOSTNAME}`;
      const passwordHash = await bcrypt.hash(password, 10);
      const cred = await prisma.domainSmtpCredential.create({
        data: {
          organizationId: orgId,
          domainId: id,
          username,
          passwordHash,
          host: INBOXFLOW_SMTP_HOSTNAME,
          port: INBOXFLOW_SMTP_LISTEN_PORT,
          encryption: 'STARTTLS',
          dailyLimit: INBOXFLOW_SMTP_DAILY_LIMIT,
          sentDay: '',
        },
      });

      return reply.status(201).send({
        note: 'Add these in SMTP Manager. Leave running campaigns on their current SMTP — this does not switch them.',
        passwordOnce: password,
        credential: {
          id: cred.id,
          host: cred.host,
          port: cred.port,
          encryption: cred.encryption,
          username: cred.username,
          fromExample: `hello@${domain.domain}`,
          dailyLimit: cred.dailyLimit,
        },
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id/smtp-credentials/:credId', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id, credId } = request.params as { id: string; credId: string };
      const deleted = await prisma.domainSmtpCredential.deleteMany({
        where: { id: credId, domainId: id, organizationId: orgId },
      });
      if (!deleted.count) throw new AppError(404, 'Credential not found');
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      const deleted = await prisma.domain.deleteMany({ where: { id, organizationId: orgId } });
      if (!deleted.count) throw new AppError(404, 'Domain not found');
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function dnsKind(type: string): 'TXT' | 'CNAME' {
  return type === 'TRACKING' || type === 'RETURN_PATH' ? 'CNAME' : 'TXT';
}

function withDnsMeta(
  domain: string,
  record: { type: string; host: string; value: string; status: string } | undefined,
) {
  if (!record) return undefined;
  return {
    ...record,
    dnsType: dnsKind(record.type),
    fqdn: record.host === '@' ? domain : `${record.host}.${domain}`,
  };
}

function getSetupInstructions(
  domain: string,
  records: Array<{ type: string; host: string; value: string; status: string }>,
  smtpHosts: string[] = [],
) {
  const recommended = recommendedSpfForHosts(
    smtpHosts,
    records.find((r) => r.type === 'SPF')?.value,
  );
  const providerNames = recommended.hints.map((h) => h.label).join(', ') || 'your SMTP';
  const spfRecord = records.find((r) => r.type === 'SPF');
  const shownSpf = spfRecord
    ? { ...spfRecord, value: recommended.record }
    : { type: 'SPF', host: '@', value: recommended.record, status: 'PENDING' };
  const dkimExtra = recommended.hints.map((h) => h.dkimHint).filter(Boolean).join(' ');
  const verify = records.find((r) => r.type === 'CUSTOM');
  const tableSource = [shownSpf, ...records.filter((r) => r.type !== 'SPF')];

  return {
    title: `Authenticate ${domain}`,
    smtpHosts,
    sending:
      `Add the 3 TXT records (SPF, DKIM, DMARC) Inbox Flow generated. Inbox Flow checks DNS on its own and marks them verified when they propagate. Verify DNS checks immediately. Then Generate SMTP and paste host smtp.inboxflow.io into SMTP Manager. Tracking / bounce CNAMEs are optional.`,
    dnsRecords: tableSource.map((r) => withDnsMeta(domain, r)),
    steps: [
      {
        step: 1,
        title: 'Add SPF record',
        description:
          `Authorize ${providerNames} to send for this domain. Merge into one SPF TXT (do not create a second v=spf1). For Brevo that means include:spf.brevo.com — not the SMTP Provider IP 136.243.17.45 unless that SMTP is also active.`,
        record: withDnsMeta(domain, shownSpf),
      },
      {
        step: 2,
        title: 'Add DKIM record',
        description:
          dkimExtra ||
          'Publish this TXT at your DNS host (Cloudflare, Namecheap, GoDaddy, …) so receivers can verify the signature.',
        record: withDnsMeta(domain, records.find((r) => r.type === 'DKIM')),
      },
      {
        step: 3,
        title: 'Add DMARC record',
        description: 'Start with p=none to monitor, then tighten policy.',
        record: withDnsMeta(domain, records.find((r) => r.type === 'DMARC')),
      },
      {
        step: 4,
        title: 'Custom tracking domain (recommended)',
        description: 'Improves link reputation by using your own domain for click tracking.',
        record: withDnsMeta(domain, records.find((r) => r.type === 'TRACKING')),
      },
      {
        step: 5,
        title: 'Return-Path / Bounce domain',
        description: 'Routes bounce processing through a domain you control.',
        record: withDnsMeta(domain, records.find((r) => r.type === 'RETURN_PATH')),
      },
      ...(verify
        ? [
            {
              step: 6,
              title: 'Ownership TXT (optional)',
              description: 'Some registrars need this extra TXT. Not required for sending once SPF/DKIM/DMARC pass.',
              record: withDnsMeta(domain, verify),
            },
          ]
        : []),
    ],
    tip: `In your DNS panel (Cloudflare, Namecheap, GoDaddy) add Type + Host + Value exactly as shown. Host is the short name (@ not ${domain}). Only SPF + DKIM + DMARC are required for Inbox Flow SMTP.`,
  };
}
