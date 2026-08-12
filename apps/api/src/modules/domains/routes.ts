import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createPublicKey, generateKeyPairSync } from 'crypto';
import { resolveTxt, resolveCname } from 'dns/promises';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { encrypt, generateToken } from '../../utils/crypto.js';
import { requireOrg } from '../../utils/org.js';
import { parseProviderConfig } from '../../services/email/providers.js';
import {
  missingSpfMechanisms,
  recommendedSpfForHosts,
} from '../deliverability/smtp-auth-hints.js';

async function orgSmtpHosts(organizationId: string): Promise<string[]> {
  const providers = await prisma.emailProvider.findMany({
    where: { organizationId, isActive: true },
    select: { config: true, type: true },
  });
  const hosts: string[] = [];
  for (const p of providers) {
    try {
      const cfg = parseProviderConfig(p.config);
      if (cfg.host) hosts.push(cfg.host);
    } catch {
      /* skip bad config */
    }
  }
  return hosts;
}

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
        include: { dnsRecords: true },
        orderBy: { createdAt: 'desc' },
      });
      return reply.send({
        domains: domains.map((d) => ({
          ...d,
          dkimPrivateKeyEnc: undefined,
          hasDkimPrivateKey: Boolean(d.dkimPrivateKeyEnc),
          dkimSelector: d.dkimSelector,
        })),
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
      const domain = await prisma.domain.findFirst({
        where: { id, organizationId: orgId },
        include: { dnsRecords: true },
      });
      if (!domain) throw new AppError(404, 'Domain not found');

      const smtpHosts = await orgSmtpHosts(orgId);
      const authHints = recommendedSpfForHosts(smtpHosts);
      const requiredMechs = authHints.hints.flatMap((h) => h.spfMechanisms);
      const results: Array<{ type: string; status: string; detail?: string }> = [];

      for (const record of domain.dnsRecords) {
        let valid = false;
        let detail = '';
        try {
          if (record.type === 'SPF' || record.type === 'DMARC' || record.type === 'DKIM' || record.type === 'CUSTOM') {
            const host =
              record.host === '@'
                ? domain.domain
                : `${record.host}.${domain.domain}`;
            const txts = await resolveTxt(host).catch(() => [] as string[][]);
            const flat = txts.map((t) => t.join(''));
            valid = flat.some((t) => t.includes(record.value.slice(0, 20)) || t.includes('v=spf1') || t.includes('v=DMARC1') || t.includes('v=DKIM1') || t.includes(record.value));
            if (record.type === 'SPF') {
              const live = flat.find((t) => t.includes('v=spf1')) || '';
              const merged = recommendedSpfForHosts(smtpHosts, live || record.value);
              const missing = live ? missingSpfMechanisms(live, requiredMechs) : requiredMechs;
              valid = Boolean(live) && missing.length === 0;
              detail = live
                ? missing.length
                  ? `Live SPF is missing ${missing.join(', ')} for your active SMTP. Recommended: ${merged.record}`
                  : live
                : `No SPF TXT found. Add: ${merged.record}`;
              if (merged.record !== record.value) {
                await prisma.dnsRecord.update({
                  where: { id: record.id },
                  data: { value: merged.record },
                });
              }
            }
            if (record.type === 'DMARC') valid = flat.some((t) => t.includes('v=DMARC1'));
            if (record.type !== 'SPF') detail = detail || flat.join(' | ') || 'No TXT records found';
          } else if (record.type === 'TRACKING' || record.type === 'RETURN_PATH') {
            const host = `${record.host}.${domain.domain}`;
            const cnames = await resolveCname(host).catch(() => [] as string[]);
            valid = cnames.some((c) => c.includes(record.value) || c.length > 0);
            detail = cnames.join(', ') || 'No CNAME found';
          }
        } catch (e) {
          detail = e instanceof Error ? e.message : 'Lookup failed';
        }

        await prisma.dnsRecord.update({
          where: { id: record.id },
          data: { status: valid ? 'VALID' : 'INVALID', lastChecked: new Date() },
        });
        results.push({ type: record.type, status: valid ? 'VALID' : 'INVALID', detail });
      }

      const spfValid = results.find((r) => r.type === 'SPF')?.status === 'VALID';
      const dkimValid = results.find((r) => r.type === 'DKIM')?.status === 'VALID';
      const dmarcValid = results.find((r) => r.type === 'DMARC')?.status === 'VALID';
      const trackingValid = results.find((r) => r.type === 'TRACKING')?.status === 'VALID';
      const returnPathValid = results.find((r) => r.type === 'RETURN_PATH')?.status === 'VALID';

      const allCore = spfValid && dkimValid && dmarcValid;
      const reputationScore =
        (spfValid ? 30 : 0) + (dkimValid ? 35 : 0) + (dmarcValid ? 25 : 0) + (trackingValid ? 5 : 0) + (returnPathValid ? 5 : 0);

      const updated = await prisma.domain.update({
        where: { id },
        data: {
          spfValid,
          dkimValid,
          dmarcValid,
          trackingValid,
          returnPathValid,
          reputationScore,
          status: allCore ? 'VERIFIED' : 'VERIFYING',
          lastVerifiedAt: new Date(),
        },
        include: { dnsRecords: true },
      });

      return reply.send({
        domain: updated,
        results,
        instructions: getSetupInstructions(domain.domain, updated.dnsRecords, smtpHosts),
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

  app.delete('/:id', async (request, reply) => {
    try {
      const orgId = requireOrg(request.user.organizationId);
      const { id } = request.params as { id: string };
      await prisma.domain.deleteMany({ where: { id, organizationId: orgId } });
      return reply.send({ success: true });
    } catch (error) {
      return sendError(reply, error);
    }
  });
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

  return {
    title: `Authenticate ${domain}`,
    steps: [
      {
        step: 1,
        title: 'Add SPF record',
        description:
          `Authorize ${providerNames} to send for this domain. Merge into one SPF TXT (do not create a second v=spf1). For Brevo that means include:spf.brevo.com — not the SMTP Provider IP 136.243.17.45 unless that SMTP is also active.`,
        record: shownSpf,
      },
      {
        step: 2,
        title: 'Add DKIM record',
        description:
          dkimExtra ||
          'Publish the DKIM public key so providers can verify message signatures.',
        record: records.find((r) => r.type === 'DKIM'),
      },
      {
        step: 3,
        title: 'Add DMARC record',
        description: 'Start with p=none to monitor, then tighten policy.',
        record: records.find((r) => r.type === 'DMARC'),
      },
      {
        step: 4,
        title: 'Custom tracking domain (recommended)',
        description: 'Improves link reputation by using your own domain for click tracking.',
        record: records.find((r) => r.type === 'TRACKING'),
      },
      {
        step: 5,
        title: 'Return-Path / Bounce domain',
        description: 'Routes bounce processing through a domain you control.',
        record: records.find((r) => r.type === 'RETURN_PATH'),
      },
    ],
    tip: `You must own this domain’s DNS. If you send with Brevo, Gmail checks SPF against include:spf.brevo.com on the From domain (and on client.${domain} if you From that host). The SMTP Provider IP 136.243.17.45 is only for akoneseo, not Brevo. Wait 10–30 minutes after DNS changes, then placement-test and open Gmail → Show original → SPF: PASS.`,
  };
}
