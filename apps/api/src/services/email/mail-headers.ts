/**
 * Outbound mail shape helpers for better inbox placement.
 * Cannot force Gmail/Outlook inbox — strengthens MIME, From alignment, and headers.
 */

export function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 0) return '';
  return address.slice(at + 1).trim().toLowerCase();
}

export function buildMessageId(fromEmail: string): string {
  const domain = emailDomain(fromEmail) || 'localhost';
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  return `<${id}@${domain}>`;
}

/** True when From domain looks unrelated to SMTP login (common spam signal). */
export function fromDomainMisaligned(fromEmail: string, smtpUser: string): boolean {
  const fromDom = emailDomain(fromEmail);
  const userDom = emailDomain(smtpUser);
  if (!fromDom || !userDom) return false;
  if (fromDom === userDom) return false;
  // allow subdomain match (mail.example.com vs example.com)
  if (fromDom.endsWith(`.${userDom}`) || userDom.endsWith(`.${fromDom}`)) return false;
  return true;
}

/** Consumer mailboxes that third-party SMTP (Bulko, SES, etc.) usually cannot send as. */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
]);

export function isConsumerMailDomain(domain: string): boolean {
  return CONSUMER_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export function smtpHostAllowsConsumerFrom(host: string, fromDomain: string): boolean {
  const h = host.trim().toLowerCase();
  const d = fromDomain.trim().toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return /gmail|google/.test(h);
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(d)) {
    return /outlook|office365|microsoft|hotmail|live\.com/.test(h);
  }
  if (d === 'yahoo.com' || d === 'yahoo.co.uk' || d === 'ymail.com') return /yahoo/.test(h);
  return false;
}

/**
 * Resolve From for SMTP. Prefer the requested campaign/profile From.
 * Do not hard-block free-mail From — let the SMTP provider accept or reject.
 */
export function resolveSmtpFromEmail(
  requestedFrom: string | undefined,
  config: { fromEmail?: string; user?: string; host?: string },
): { from: string; adjusted: boolean; blockReason?: string } {
  const cfgFrom = String(config.fromEmail || config.user || '').trim();
  const requested = String(requestedFrom || '').trim();
  if (requested) return { from: requested, adjusted: false };
  if (cfgFrom.includes('@')) return { from: cfgFrom, adjusted: true };
  return { from: cfgFrom || 'noreply@localhost', adjusted: false };
}

/** Turn raw nodemailer/SMTP errors into actionable copy. */
export function explainSmtpSendFailure(raw: string): string {
  const msg = String(raw || 'SMTP send failed').trim();
  if (/554|5\.7\.1|content filter|rejected by content|spam/i.test(msg)) {
    return (
      `${msg} — Your SMTP provider blocked this before delivery. Fix: ` +
      `(1) From address must be on a domain authorized with that SMTP (not @gmail.com via Bulko), ` +
      `(2) honest content + links on your domain, ` +
      `(3) SPF/DKIM for that domain. ` +
      `A plain “SMTP connection test” can succeed while campaign HTML is still rejected.`
    );
  }
  if (/530|authentication required|auth required/i.test(msg)) {
    return (
      `${msg} — SMTP login did not complete. Re-enter the correct Username and Password from your provider, ` +
      `Save, then Test Connection. If “Allow insecure TLS” is on, that only skips cert checks — STARTTLS/AUTH still run.`
    );
  }
  if (/550|sender.*reject|not owned|not allowed/i.test(msg)) {
    return (
      `${msg} — Sender address not allowed by SMTP. Use the From email your provider authorized.`
    );
  }
  return msg;
}

export function formatFromHeader(fromEmail: string, fromName?: string | null): string {
  const email = fromEmail.trim();
  const name = String(fromName || '').trim().replaceAll('"', '');
  return name ? `"${name}" <${email}>` : email;
}
