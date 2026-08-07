import {
  findRemainingSpamPhrases,
  scrubSpamFromHtml,
  scrubSpamFromText,
  sentenceCaseSubject,
} from './spam-content-filter.ts';

function uppercaseRatio(value: string) {
  const letters = value.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

export function validateCampaignContent(subject: string, htmlBody: string) {
  const subjectScrub = scrubSpamFromText(subject);
  const htmlScrub = scrubSpamFromHtml(
    htmlBody
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .trim()
      .slice(0, 100000),
  );
  const sanitizedSubject = sentenceCaseSubject(subjectScrub.text).replace(/!{2,}/g, '!').slice(0, 180);
  const sanitizedHtml = htmlScrub.text;

  if (!sanitizedSubject) throw new Error('Subject line is required');
  if (!sanitizedHtml) throw new Error('HTML body is required');
  if (uppercaseRatio(sanitizedSubject) > 0.6) {
    throw new Error('Subject uses too many capital letters. Use sentence case to avoid spam filters.');
  }

  const plainForCheck = sanitizedHtml
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const remaining = findRemainingSpamPhrases(`${sanitizedSubject} ${plainForCheck}`);
  if (remaining.length > 0) {
    throw new Error(
      `Content still includes spam trigger phrase "${remaining[0]}" after auto-filter. Rephrase before sending.`,
    );
  }

  return { sanitizedSubject, sanitizedHtml };
}

/** Remove app-managed unsubscribe placeholders — templates supply their own links. */
export function stripAppUnsubscribeTokens(content: string) {
  return content.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, '');
}

export function buildDeliverabilityHeaders(replyTo?: string, listUnsubscribeUrl?: string) {
  // Do not brand X-Mailer — custom "Inbox Flow" fingerprint can hurt filtering.
  const headers: Record<string, string> = {};
  if (replyTo) headers['Reply-To'] = replyTo;
  if (listUnsubscribeUrl?.trim()) {
    headers['List-Unsubscribe'] = `<${listUnsubscribeUrl.trim()}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

export function htmlToPlainText(html: string) {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export function extractDomain(email: string) {
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
      `From address uses free provider @${fromDomain}. Free mailboxes (Gmail / Outlook / Yahoo / iCloud) run strict DMARC reject on sends through 3rd-party SMTP. Most campaigns from free email addresses land in Spam. Use a From email on YOUR OWN verified domain with SPF + DKIM + DMARC.`,
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
      `SMTP login domain (${loginDomain}) differs from From domain (${fromDomain}). Add SPF v=spf1 include:${loginDomain} ~all on the From domain or align them to pass alignment.`,
    );
  }

  const isSharedBulk = SHARED_BULK_HOST_HINTS.some((h) => host.includes(h));
  if (isSharedBulk && fromDomain && !FREE_EMAIL_HOSTS.has(fromDomain)) {
    warnings.push(
      'Shared bulk SMTP (SendGrid / Brevo / Mailchimp / etc). You MUST verify/authenticate your From domain on their dashboard with SPF + DKIM + DMARC. Sending without a verified domain usually lands in Promotions/Spam.',
    );
  }

  if (!fromDomain && host) {
    warnings.push(
      'From/Sender email blank — spam filters flag empty From field; SPF/DKIM/DMARC cannot validate the sender. Sends with empty From almost always go to Spam or bounce. Use a real From address on your own domain.',
    );
  }

  return warnings;
}

export function detectSmtpConfigIssues(config: Record<string, string | number | boolean | undefined>): string[] {
  const issues: string[] = [];
  const host = String(config.host || '').trim();
  const port = Number(config.port || 0);
  const user = String(config.user || '').trim();
  const pass = String(config.pass || '').trim();

  if (!host) issues.push('SMTP host is required (e.g. smtp.yourdomain.com).');
  if (!user) issues.push('SMTP username is required (usually your login email).');
  if (!pass) issues.push('SMTP password is required (if using Gmail/Outlook use an App Password, not your account password).');
  if (!port || port <= 0 || port > 65535) issues.push('SMTP port is invalid (use 587 for STARTTLS or 465 for SSL).');
  if (host.includes('localhost') || host === '127.0.0.1') issues.push('Localhost SMTP is not available in production environments.');
  const ignoreTLS = ['true', '1', 'yes', 'on'].includes(String(config.ignoreTLS || '').toLowerCase());
  if (ignoreTLS) issues.push('ignoreTLS is dangerous — never send credentials or marketing email in plain text.');
  return issues;
}
