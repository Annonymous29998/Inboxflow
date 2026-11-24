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
import { trackingCnameTarget } from '../../services/email/public-url.js';

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

      const taken = await prisma.domain.count({ where: { organizationId: orgId } });
      if (taken > 0) {
        throw new AppError(409, 'Delete the current tracking domain before adding another.');
      }

      const smtpHosts = await orgSmtpHosts(orgId);
      const domain = await prisma.domain.create({
        data: {
          organizationId: orgId,
          domain: domainName,
          trackingDomain: `track.${domainName}`,
          dnsRecords: {
            create: [
              {
                type: 'TRACKING',
                host: 'track',
                value: trackingCnameTarget(),
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
          hasDkimPrivateKey: false,
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
      const checked = await verifyOrganizationDomain(orgId, id, request.headers.authorization);
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
  const optional = record.type === 'RETURN_PATH' || record.type === 'CUSTOM';
  return {
    ...record,
    optional,
    dnsType: dnsKind(record.type),
    fqdn: record.host === '@' ? domain : `${record.host}.${domain}`,
  };
}

function getSetupInstructions(
  domain: string,
  records: Array<{ type: string; host: string; value: string; status: string }>,
  smtpHosts: string[] = [],
) {
  const tracking = records.find((r) => r.type === 'TRACKING');
  const spfRecord = records.find((r) => r.type === 'SPF');
  if (tracking && !spfRecord) {
    return {
      title: `Tracking domain ${domain}`,
      smtpHosts,
      sending:
        `Add one CNAME. Opens, clicks, and unsubscribe for every SMTP profile use https://track.${domain} after HTTPS is ready. Until then those links stay on the public site. This domain does not need a website, and it does not have to be an address you send from. Delete it and add another to switch later sends.`,
      dnsRecords: [withDnsMeta(domain, tracking)],
      steps: [
        {
          step: 1,
          title: 'Point track at the mailer',
          description:
            'Add this CNAME with proxy off (DNS only). Inbox Flow requests the HTTPS certificate after the name is visible. A domain with no website is enough.',
          record: withDnsMeta(domain, tracking),
        },
      ],
      tip: 'One tracking domain per account. Every SMTP profile shares it. Leave the DNS proxy off so the CNAME stays visible.',
    };
  }

  const recommended = recommendedSpfForHosts(
    smtpHosts,
    spfRecord?.value,
  );
  const providerNames = recommended.hints.map((h) => h.label).join(', ') || 'your SMTP';
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
      `Opens, clicks, and unsubscribe use https://track.${domain} after the tracking CNAME and HTTPS are ready. SPF, DKIM, and DMARC are for the address you send from. Bounce and ownership records are optional.`,
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
        title: 'Tracking CNAME',
        description: 'Point track at the mailer, proxy off. This is the hostname used for opens, clicks, and unsubscribe once HTTPS is ready.',
        record: withDnsMeta(domain, records.find((r) => r.type === 'TRACKING')),
      },
      {
        step: 5,
        title: 'Return-Path / Bounce domain',
        description: 'Optional. Bounce handling does not depend on this record. Skip it if you do not control the target hostname.',
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
