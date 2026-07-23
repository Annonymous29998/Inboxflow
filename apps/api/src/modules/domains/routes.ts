import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTxt, resolveCname } from 'dns/promises';
import { prisma } from '../../config/prisma.js';
import { AppError, sendError } from '../../utils/errors.js';
import { authenticate } from '../../middleware/auth.js';
import { generateToken } from '../../utils/crypto.js';
import { requireOrg } from '../../utils/org.js';

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
      return reply.send({ domains });
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

      const dkimSelector = 'icoffee';
      const dkimValue = `v=DKIM1; k=rsa; p=${generateToken(64)}`; // placeholder public key for wizard
      const verificationToken = generateToken(16);

      const domain = await prisma.domain.create({
        data: {
          organizationId: orgId,
          domain: domainName,
          trackingDomain: `track.${domainName}`,
          returnPath: `bounce.${domainName}`,
          dnsRecords: {
            create: [
              {
                type: 'SPF',
                host: '@',
                value: `v=spf1 include:_spf.inboxflow.io ~all`,
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
                host: '_icoffee-verify',
                value: verificationToken,
              },
            ],
          },
        },
        include: { dnsRecords: true },
      });

      return reply.status(201).send({
        domain,
        instructions: getSetupInstructions(domainName, domain.dnsRecords),
      });
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
            if (record.type === 'SPF') valid = flat.some((t) => t.includes('v=spf1'));
            if (record.type === 'DMARC') valid = flat.some((t) => t.includes('v=DMARC1'));
            detail = flat.join(' | ') || 'No TXT records found';
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
        instructions: getSetupInstructions(domain.domain, updated.dnsRecords),
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
      return reply.send({ instructions: getSetupInstructions(domain.domain, domain.dnsRecords), domain });
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

function getSetupInstructions(domain: string, records: Array<{ type: string; host: string; value: string; status: string }>) {
  return {
    title: `Authenticate ${domain}`,
    steps: [
      {
        step: 1,
        title: 'Add SPF record',
        description: 'Authorize Inbox Flow (and your ESP) to send email for your domain.',
        record: records.find((r) => r.type === 'SPF'),
      },
      {
        step: 2,
        title: 'Add DKIM record',
        description: 'Publish the DKIM public key so providers can verify message signatures.',
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
    tip: 'DNS changes can take up to 48 hours to propagate. Click Verify after publishing records.',
  };
}
