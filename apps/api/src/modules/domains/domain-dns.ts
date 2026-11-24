import { resolveCname, resolveTxt } from 'dns/promises';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { parseProviderConfig } from '../../services/email/providers.js';
import { missingSpfMechanisms, recommendedSpfForHosts } from '../deliverability/smtp-auth-hints.js';
import { ensureTrackingHttps } from '../../services/email/tracking-cert.js';
import { trackingCnameTarget } from '../../services/email/public-url.js';

export type IssuedRecord = { id?: string; type: string; host: string; value: string };

export type LiveDns = { txt: string[]; cname: string[] };

function compact(value: string): string {
  return String(value || '').replace(/["'\s]/g, '').toLowerCase();
}

function dkimPublicKey(value: string): string {
  const match = String(value || '').match(/p=([A-Za-z0-9+/=\s]+)/i);
  return compact(match?.[1] || '');
}

/** True when live DNS contains the record Inbox Flow told the user to add. */
export function judgeIssuedRecord(
  record: { type: string; value: string },
  live: LiveDns,
  requiredSpfMechanisms: string[],
): { valid: boolean; detail: string } {
  const txt = live.txt.map((row) => row.trim()).filter(Boolean);
  if (record.type === 'SPF') {
    const liveSpf = txt.find((row) => row.toLowerCase().includes('v=spf1')) || '';
    const missing = liveSpf ? missingSpfMechanisms(liveSpf, requiredSpfMechanisms) : requiredSpfMechanisms;
    const valid = Boolean(liveSpf) && missing.length === 0;
    return {
      valid,
      detail: liveSpf
        ? missing.length
          ? `Live SPF is missing ${missing.join(', ')}`
          : liveSpf
        : 'No SPF TXT found',
    };
  }
  if (record.type === 'DKIM') {
    const key = dkimPublicKey(record.value);
    const valid = Boolean(key) && txt.some((row) => compact(row).includes(key));
    return { valid, detail: txt.join(' | ') || 'No TXT records found' };
  }
  if (record.type === 'DMARC') {
    const valid = txt.some((row) => row.toLowerCase().includes('v=dmarc1'));
    return { valid, detail: txt.join(' | ') || 'No TXT records found' };
  }
  if (record.type === 'CUSTOM') {
    const token = compact(record.value);
    const valid = Boolean(token) && txt.some((row) => compact(row).includes(token));
    return { valid, detail: txt.join(' | ') || 'No TXT records found' };
  }
  if (record.type === 'TRACKING' || record.type === 'RETURN_PATH') {
    const expected = record.value.toLowerCase().replace(/\.$/, '');
    const names = live.cname.map((name) => name.toLowerCase().replace(/\.$/, ''));
    const valid = Boolean(expected) && names.some((name) => name === expected || name.endsWith(`.${expected}`));
    return { valid, detail: names.join(', ') || 'No CNAME found' };
  }
  return { valid: false, detail: 'Unknown record type' };
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function readLiveDns(host: string, kind: 'TXT' | 'CNAME'): Promise<LiveDns> {
  if (kind === 'CNAME') {
    const cname = await withTimeout(resolveCname(host), 8000, [] as string[]);
    return { txt: [], cname };
  }
  const txts = await withTimeout(resolveTxt(host), 8000, [] as string[][]);
  return { txt: txts.map((parts) => parts.join('')), cname: [] };
}

export function isOptionalDnsRecord(type: string): boolean {
  return type === 'RETURN_PATH' || type === 'CUSTOM';
}

/** A missing optional record stays pending. It does not block domain verification. */
export function dnsCheckStatus(type: string, valid: boolean): 'VALID' | 'INVALID' | 'PENDING' {
  if (valid) return 'VALID';
  if (isOptionalDnsRecord(type)) return 'PENDING';
  return 'INVALID';
}

export function dnsHost(domain: string, host: string): string {
  return host === '@' ? domain : `${host}.${domain}`;
}

export async function orgSmtpHosts(organizationId: string): Promise<string[]> {
  const providers = await prisma.emailProvider.findMany({
    where: { organizationId, isActive: true },
    select: { config: true },
  });
  const hosts: string[] = [];
  for (const provider of providers) {
    try {
      const cfg = parseProviderConfig(provider.config);
      if (cfg.host) hosts.push(cfg.host);
    } catch {
      /* skip a profile that cannot be read */
    }
  }
  if (env.SMTP_HOST && !['json', 'dev', 'console'].includes(env.SMTP_HOST.toLowerCase())) {
    hosts.push(env.SMTP_HOST);
  }
  return hosts;
}

export async function verifyOrganizationDomain(
  organizationId: string,
  domainId: string,
  authorization?: string | null,
) {
  const domain = await prisma.domain.findFirst({
    where: { id: domainId, organizationId },
    include: { dnsRecords: true },
  });
  if (!domain) return null;

  const smtpHosts = await orgSmtpHosts(organizationId);
  const authHints = recommendedSpfForHosts(smtpHosts);
  const requiredMechs = authHints.hints.flatMap((hint) => hint.spfMechanisms);
  const results: Array<{ type: string; status: string; detail?: string }> = [];

  for (const record of domain.dnsRecords) {
    if (record.type === 'TRACKING' && record.value !== trackingCnameTarget()) {
      record.value = trackingCnameTarget();
      await prisma.dnsRecord.update({ where: { id: record.id }, data: { value: record.value } });
    }
    const kind = record.type === 'TRACKING' || record.type === 'RETURN_PATH' ? 'CNAME' : 'TXT';
    let judged = { valid: false, detail: 'Lookup failed' };
    try {
      const live = await readLiveDns(dnsHost(domain.domain, record.host), kind);
      judged = judgeIssuedRecord(record, live, requiredMechs);
      if (record.type === 'SPF') {
        const liveSpf = live.txt.find((row) => row.toLowerCase().includes('v=spf1'));
        const merged = recommendedSpfForHosts(smtpHosts, liveSpf || record.value);
        if (merged.record !== record.value) {
          await prisma.dnsRecord.update({ where: { id: record.id }, data: { value: merged.record } });
        }
      }
    } catch (error) {
      judged = { valid: false, detail: error instanceof Error ? error.message : 'Lookup failed' };
    }

    const status = dnsCheckStatus(record.type, judged.valid);
    await prisma.dnsRecord.update({
      where: { id: record.id },
      data: { status, lastChecked: new Date() },
    });
    results.push({ type: record.type, status, detail: judged.detail });
  }

  const spfValid = results.find((row) => row.type === 'SPF')?.status === 'VALID';
  const dkimValid = results.find((row) => row.type === 'DKIM')?.status === 'VALID';
  const dmarcValid = results.find((row) => row.type === 'DMARC')?.status === 'VALID';
  const trackingDns = results.find((row) => row.type === 'TRACKING')?.status === 'VALID';
  const returnPathValid = results.find((row) => row.type === 'RETURN_PATH')?.status === 'VALID';
  const hasTrackingRecord = domain.dnsRecords.some((row) => row.type === 'TRACKING');
  let trackingValid = false;
  if (trackingDns && domain.trackingDomain) {
    trackingValid = await ensureTrackingHttps(domain.trackingDomain, authorization);
    if (!trackingValid) {
      const trackingRecord = domain.dnsRecords.find((row) => row.type === 'TRACKING');
      if (trackingRecord) {
        await prisma.dnsRecord.update({
          where: { id: trackingRecord.id },
          data: { status: 'PENDING', lastChecked: new Date() },
        });
      }
      const pending = results.find((row) => row.type === 'TRACKING');
      if (pending) {
        pending.status = 'PENDING';
        pending.detail = 'CNAME is published. HTTPS for this name is not ready yet.';
      }
    }
  }
  const allCore = Boolean(spfValid && dkimValid && dmarcValid);
  const verified = hasTrackingRecord ? trackingValid : allCore;
  const reputationScore =
    (spfValid ? 30 : 0) + (dkimValid ? 35 : 0) + (dmarcValid ? 25 : 0) + (trackingValid ? 5 : 0) + (returnPathValid ? 5 : 0);

  const updated = await prisma.domain.update({
    where: { id: domain.id },
    data: {
      spfValid,
      dkimValid,
      dmarcValid,
      trackingValid,
      returnPathValid,
      reputationScore,
      status: verified ? 'VERIFIED' : 'VERIFYING',
      lastVerifiedAt: new Date(),
    },
    include: { dnsRecords: true },
  });

  return { domain: updated, results, smtpHosts };
}

let watchRunning = false;

/** Look up pending domains on a timer. A published record verifies without a button click. */
export function startDomainPropagationWatch(): void {
  const tick = async () => {
    if (watchRunning) return;
    watchRunning = true;
    try {
      const pending = await prisma.domain.findMany({
        where: { status: { not: 'VERIFIED' } },
        select: { id: true, organizationId: true },
        take: 25,
        orderBy: { updatedAt: 'asc' },
      });
      for (const row of pending) {
        await verifyOrganizationDomain(row.organizationId, row.id).catch((error) => {
          console.error('Domain DNS watch failed', row.id, error);
        });
      }
    } catch (error) {
      console.error('Domain DNS watch failed', error);
    } finally {
      watchRunning = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref?.();
  setTimeout(() => {
    void tick();
  }, 5_000).unref?.();
}
