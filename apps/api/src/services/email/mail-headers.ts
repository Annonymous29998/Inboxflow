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

/** True when email is on a domain the org verified (or a subdomain of it). */
export function isAuthorizedFromDomain(email: string, domains: string[] | undefined): boolean {
  const d = emailDomain(email);
  if (!d || !domains?.length) return false;
  return domains.some((own) => {
    const o = String(own || '')
      .trim()
      .toLowerCase();
    return Boolean(o) && (d === o || d.endsWith(`.${o}`));
  });
}

export type SmtpFromIdentity = { email: string; name: string };

function addSmtpIdentity(out: SmtpFromIdentity[], email?: string, name?: string) {
  const e = String(email || '').trim();
  if (!e.includes('@')) return;
  const existing = out.find((x) => x.email.toLowerCase() === e.toLowerCase());
  const n = String(name || '').trim();
  if (existing) {
    if (n && !existing.name) existing.name = n;
    return;
  }
  out.push({ email: e, name: n });
}

function collectFromIdentitiesField(config: {
  fromIdentities?: string | SmtpFromIdentity[] | Array<string | SmtpFromIdentity>;
}): SmtpFromIdentity[] {
  const out: SmtpFromIdentity[] = [];
  const rawIdent = config.fromIdentities;
  if (Array.isArray(rawIdent)) {
    for (const row of rawIdent) {
      if (typeof row === 'string') addSmtpIdentity(out, row);
      else if (row && typeof row === 'object') addSmtpIdentity(out, row.email, row.name);
    }
  } else if (typeof rawIdent === 'string' && rawIdent.trim()) {
    try {
      const parsed = JSON.parse(rawIdent) as unknown;
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (typeof row === 'string') addSmtpIdentity(out, row);
          else if (row && typeof row === 'object') {
            const r = row as SmtpFromIdentity;
            addSmtpIdentity(out, r.email, r.name);
          }
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Drop the SMTP username if it was auto-appended as an extra From. */
export function withoutAutoSmtpLoginFrom(
  identities: SmtpFromIdentity[],
  smtpUser?: string,
): SmtpFromIdentity[] {
  const login = String(smtpUser || '')
    .trim()
    .toLowerCase();
  if (!login.includes('@') || identities.length < 2) return identities;
  const kept = identities.filter((i) => i.email.toLowerCase() !== login);
  return kept.length ? kept : identities;
}

/** All From addresses saved on one SMTP profile (plus legacy single fromEmail). */
export function parseSmtpFromIdentities(config: {
  fromEmail?: string;
  fromName?: string;
  user?: string;
  fromIdentities?: string | SmtpFromIdentity[] | Array<string | SmtpFromIdentity>;
  fromEmails?: string | string[];
}): SmtpFromIdentity[] {
  const listed = collectFromIdentitiesField(config);
  if (listed.length) return withoutAutoSmtpLoginFrom(listed, config.user);

  const out: SmtpFromIdentity[] = [];
  const rawEmails = config.fromEmails;
  if (Array.isArray(rawEmails)) {
    for (const e of rawEmails) addSmtpIdentity(out, e);
  } else if (typeof rawEmails === 'string' && rawEmails.trim()) {
    try {
      const parsed = JSON.parse(rawEmails) as unknown;
      if (Array.isArray(parsed)) for (const e of parsed) addSmtpIdentity(out, String(e));
    } catch {
      for (const line of rawEmails.split(/[\n,;]+/)) addSmtpIdentity(out, line);
    }
  }
  addSmtpIdentity(out, config.fromEmail, config.fromName);
  if (!out.length) addSmtpIdentity(out, config.user);
  return out;
}

/**
 * From address for SMTP:
 * - Any From saved on this SMTP profile, or
 * - Campaign sender on the SMTP profile’s domain, or
 * - Any mailbox on an org-verified domain (SPF + DKIM + DMARC), or
 * - Else fall back to the SMTP profile Sender Email.
 */
export function resolveSmtpFromEmail(
  requestedFrom: string | undefined,
  config: {
    fromEmail?: string;
    fromName?: string;
    user?: string;
    host?: string;
    fromIdentities?: string | SmtpFromIdentity[];
    fromEmails?: string | string[];
  },
  opts?: { authorizedDomains?: string[] },
): { from: string; adjusted: boolean; blockReason?: string } {
  const identities = parseSmtpFromIdentities(config);
  const cfgFrom = identities[0]?.email || String(config.fromEmail || config.user || '').trim();
  const requested = String(requestedFrom || '').trim();
  const host = String(config.host || '');
  const authorized = opts?.authorizedDomains || [];

  if (requested) {
    const listed = identities.find((i) => i.email.toLowerCase() === requested.toLowerCase());
    if (listed) return { from: listed.email, adjusted: false };
  }

  if (requested && isAuthorizedFromDomain(requested, authorized)) {
    return { from: requested, adjusted: false };
  }

  if (cfgFrom.includes('@')) {
    if (!requested || requested.toLowerCase() === cfgFrom.toLowerCase()) {
      return { from: cfgFrom, adjusted: false };
    }
    const reqDom = emailDomain(requested);
    const sameDomain = identities.some((i) => emailDomain(i.email) === reqDom && reqDom);
    const gmailViaGmail =
      isConsumerMailDomain(reqDom) && smtpHostAllowsConsumerFrom(host, reqDom);
    if (sameDomain || gmailViaGmail) {
      return { from: requested, adjusted: false };
    }
    return {
      from: cfgFrom,
      adjusted: true,
      blockReason: `Using SMTP profile From ${cfgFrom} (campaign had ${requested})`,
    };
  }

  if (requested) return { from: requested, adjusted: false };
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
  if (/mailbox full|over quota|quota exceeded/i.test(msg)) {
    return `${msg} — Mailbox is full (soft bounce). This recipient was not delivered.`;
  }
  if (/5\.1\.1|user unknown|no such user|mailbox unavailable/i.test(msg)) {
    return `${msg} — Address does not exist (hard bounce).`;
  }
  if (/550|sender.*reject|not owned|not allowed/i.test(msg)) {
    return (
      `${msg} — Sender address not allowed by SMTP. Use the From email your provider authorized.`
    );
  }
  if (/write unknown|econnreset|epipe|socket hang up|econnaborted|etimedout/i.test(msg)) {
    return (
      `${msg} — SMTP closed the connection while the message was uploading (often STARTTLS forced on a plain relay, or the provider dropped the socket). Inbox Flow will retry. If it keeps failing, set Encryption to None for this host (akoneseo) or STARTTLS only if they require it.`
    );
  }
  return msg;
}

/** RFC 8058 one-click is valid only when the unsubscribe URL itself is https. */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
  };
  if (/^https:\/\//i.test(unsubscribeUrl)) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

export function formatFromHeader(fromEmail: string, fromName?: string | null): string {
  const email = fromEmail.trim();
  const name = String(fromName || '').trim().replaceAll('"', '');
  return name ? `"${name}" <${email}>` : email;
}
