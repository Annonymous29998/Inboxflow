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
  const headers: Record<string, string> = {
    'X-Mailer': 'Inbox Flow',
  };
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
