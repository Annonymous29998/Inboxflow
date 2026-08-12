import { prisma } from '../config/prisma.js';

export type LogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
export type LogCategory =
  | 'smtp'
  | 'queue'
  | 'campaign'
  | 'delivery'
  | 'bounce'
  | 'auth'
  | 'system';

export async function writeSystemLog(input: {
  organizationId: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  meta?: Record<string, unknown> | unknown;
}) {
  try {
    await prisma.systemLog.create({
      data: {
        organizationId: input.organizationId,
        level: input.level,
        category: input.category,
        message: input.message,
        meta: input.meta ?? undefined,
      },
    });
  } catch (err) {
    console.error('[system-log]', err);
  }
}

export function detectSmtpConfigIssues(config: {
  host?: string;
  port?: string | number;
  encryption?: string;
  secure?: boolean | string;
  requireTLS?: boolean | string;
  user?: string;
  pass?: string;
  fromEmail?: string;
}) {
  const issues: string[] = [];
  const host = String(config.host || '').trim().toLowerCase();
  const port = Number(config.port || 0);
  const encryption = String(config.encryption || '').toUpperCase();
  const secure =
    config.secure === true ||
    config.secure === 'true' ||
    encryption === 'SSL' ||
    encryption === 'TLS';

  if (!host) issues.push('SMTP host is missing');
  if (!port || port < 1 || port > 65535) issues.push('SMTP port is invalid');
  if (!config.user) issues.push('Username is empty — most providers require authentication');
  if (!config.pass) issues.push('Password is empty');
  if (!config.fromEmail && !config.user) issues.push('Sender email is missing');

  if (port === 465 && !secure && encryption !== 'SSL') {
    issues.push('Port 465 usually requires SSL/TLS (secure=true)');
  }
  if (port === 587 && secure) {
    issues.push('Port 587 usually uses STARTTLS (secure=false, requireTLS=true)');
  }
  if (host.includes('gmail') && port === 465 && !secure) {
    issues.push('Gmail on 465 expects SSL');
  }
  if (host.includes('gmail') && !config.pass) {
    issues.push('Gmail often requires an App Password, not the account password');
  }
  if (host.includes('office365') || host.includes('outlook')) {
    if (port !== 587) issues.push('Outlook / Microsoft 365 typically uses port 587 with STARTTLS');
  }
  if (host.includes('sendgrid') && config.user && config.user !== 'apikey') {
    issues.push('SendGrid SMTP username is usually literally "apikey"');
  }

  return issues;
}

const FREE_EMAIL_HOSTS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.fr',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'outlook.com',
  'outlook.com.au',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'sina.com',
]);

const SHARED_BULK_HOST_HINTS = [
  'sendgrid',
  'brevo',
  'sendinblue',
  'mailchimp',
  'mandrill',
  'elasticemail',
  'sendpulse',
  'smtp2go',
  'socketlabs',
  'sparkpost',
  'postmark',
];

function extractDomain(email: string) {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

export function detectSmtpDeliverabilityWarnings(config: {
  host?: string;
  port?: string | number;
  fromEmail?: string;
  user?: string;
}): string[] {
  const host = String(config.host || '').trim().toLowerCase();
  const from = String(config.fromEmail || '').trim();
  const fromDomain = extractDomain(from || String(config.user || ''));
  const loginDomain = extractDomain(String(config.user || ''));
  const port = Number(config.port || 0);
  const warnings: string[] = [];

  if (port === 25) {
    warnings.push(
      'Port 25 is server-to-server relay, not client submission. Almost all ISPs/cloud block outbound port 25 — switch to 587 (STARTTLS) or 465 (SSL). Sends on port 25 usually go to Spam or bounce.',
    );
  }

  if (fromDomain && FREE_EMAIL_HOSTS.has(fromDomain)) {
    warnings.push(
      `From is @${fromDomain}. Inbox Flow will still send it. Some SMTP providers or mailbox filters may reject free-mail From addresses or send them to Spam — a verified domain From usually places better.`,
    );
  }

  if (
    fromDomain &&
    loginDomain &&
    fromDomain !== loginDomain &&
    !fromDomain.endsWith(`.${loginDomain}`) &&
    !loginDomain.endsWith(`.${fromDomain}`) &&
    !FREE_EMAIL_HOSTS.has(fromDomain) &&
    !FREE_EMAIL_HOSTS.has(loginDomain)
  ) {
    warnings.push(
      `SMTP login domain (${loginDomain}) differs from From domain (${fromDomain}). Inbox providers score this as spam-like when SPF/DKIM alignment fails. Add SPF "v=spf1 include:${loginDomain} ~all` +
        ' on the From domain OR align login to the same domain whenever possible to improve inbox placement.',
    );
  }

  const isSharedBulk = SHARED_BULK_HOST_HINTS.some((h) => host.includes(h));
  if (isSharedBulk && fromDomain && !FREE_EMAIL_HOSTS.has(fromDomain)) {
    warnings.push(
      'This SMTP host is a shared bulk/marketing SMTP (SendGrid / Brevo / Mailchimp / etc). You MUST verify/authenticate your From domain on their dashboard with SPF + DKIM + DMARC before sending. Sending without a verified domain on the shared provider delivers mail servers sends the provider will land in Spam/Gmail Promotions folder or bounce (poor sender reputation.)',
    );
  }

  if (!fromDomain && host) {
    warnings.push(
      'From/Sender email blank — spam filters flag empty From field; SPF/DKIM/DMARC cannot validate the sender. Sends with empty From almost always go to Spam or bounce. Use a real From address on your own domain.',
    );
  }

  return warnings;
}