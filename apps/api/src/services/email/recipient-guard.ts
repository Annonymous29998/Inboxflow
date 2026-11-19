import { resolveMx } from 'dns/promises';
import { emailDomain } from './mail-headers.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MX_TTL_MS = 10 * 60 * 1000;
const mxCache = new Map<string, { ok: boolean; at: number }>();

const ROLE_LOCALS = new Set([
  'abuse',
  'admin',
  'administrator',
  'billing',
  'compliance',
  'contact',
  'devnull',
  'dns',
  'ftp',
  'hostmaster',
  'info',
  'inoc',
  'ispfeedback',
  'ispsupport',
  'list',
  'list-request',
  'mail',
  'mailer-daemon',
  'marketing',
  'news',
  'newsletter',
  'nobody',
  'noc',
  'noreply',
  'no-reply',
  'null',
  'office',
  'postmaster',
  'privacy',
  'registrar',
  'root',
  'sales',
  'security',
  'spam',
  'subscribe',
  'support',
  'sysadmin',
  'undisclosed-recipients',
  'unsubscribe',
  'usenet',
  'uucp',
  'webmaster',
  'www',
]);

const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com',
  'discard.email',
  'dispostable.com',
  'emailondeck.com',
  'fakeinbox.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'mailinator.com',
  'mailnesia.com',
  'maildrop.cc',
  'mintemail.com',
  'moakt.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trash-mail.com',
  'trashmail.com',
  'yopmail.com',
]);

export type RecipientGuardCode = 'syntax' | 'role' | 'disposable' | 'no_mx';
export type RecipientGuardResult =
  | { ok: true }
  | { ok: false; code: RecipientGuardCode; reason: string };

export function emailLooksValid(email: string): boolean {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr || addr.length > 254 || !EMAIL_RE.test(addr)) return false;
  const domain = emailDomain(addr);
  return Boolean(domain && domain.includes('.') && domain.length >= 4);
}

function localPart(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at).toLowerCase() : '';
}

export function isRoleAddress(email: string): boolean {
  const local = localPart(email).replace(/[.+].*$/, '');
  return ROLE_LOCALS.has(local);
}

export function isDisposableDomain(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  for (const d of DISPOSABLE_DOMAINS) {
    if (domain.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function syncRecipientIssue(email: string): RecipientGuardResult {
  const addr = String(email || '').trim().toLowerCase();
  if (!emailLooksValid(addr)) {
    return { ok: false, code: 'syntax', reason: 'Invalid email address' };
  }
  if (isRoleAddress(addr)) {
    return { ok: false, code: 'role', reason: 'Role address skipped (admin, info, noreply, …)' };
  }
  if (isDisposableDomain(addr)) {
    return { ok: false, code: 'disposable', reason: 'Disposable mailbox skipped' };
  }
  return { ok: true };
}

async function domainHasMx(domain: string): Promise<boolean | 'transient'> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_TTL_MS) return cached.ok;
  try {
    const records = await resolveMx(domain);
    const ok = Array.isArray(records) && records.length > 0;
    mxCache.set(domain, { ok, at: Date.now() });
    return ok;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code || '';
    if (code === 'ETIMEOUT' || code === 'ECONNREFUSED' || code === 'ESERVFAIL') {
      return 'transient';
    }
    mxCache.set(domain, { ok: false, at: Date.now() });
    return false;
  }
}

export async function prefetchMxForDomains(domains: string[]): Promise<void> {
  const unique = [...new Set(domains.map((d) => d.toLowerCase().trim()).filter(Boolean))];
  const missing = unique.filter((d) => {
    const cached = mxCache.get(d);
    return !cached || Date.now() - cached.at >= MX_TTL_MS;
  });
  const batchSize = 20;
  for (let i = 0; i < missing.length; i += batchSize) {
    await Promise.all(missing.slice(i, i + batchSize).map((d) => domainHasMx(d)));
  }
}

/**
 * Cheap checks before SMTP: syntax, role/disposable, domain MX.
 * Does not probe whether a mailbox exists (VRFY / RCPT).
 */
export async function guardRecipientAddress(email: string): Promise<RecipientGuardResult> {
  const addr = String(email || '').trim().toLowerCase();
  const sync = syncRecipientIssue(addr);
  if (!sync.ok) return sync;
  const domain = emailDomain(addr);
  const mx = await domainHasMx(domain);
  if (mx === true || mx === 'transient') return { ok: true };
  return { ok: false, code: 'no_mx', reason: `No mail server (MX) for ${domain}` };
}

export async function filterDeliverableAddresses(emails: string[]): Promise<{
  deliverable: string[];
  skipped: Array<{ email: string; reason: string }>;
}> {
  const unique = [...new Set(emails.map((e) => String(e || '').trim()).filter(Boolean))];
  await prefetchMxForDomains(unique.map((e) => emailDomain(e)));
  const deliverable: string[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  for (const email of unique) {
    const g = await guardRecipientAddress(email);
    if (g.ok) deliverable.push(email);
    else skipped.push({ email, reason: g.reason });
  }
  return { deliverable, skipped };
}
