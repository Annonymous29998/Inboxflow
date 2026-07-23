import {
  findRemainingSpamPhrases,
  scrubSpamFromHtml,
  scrubSpamFromText,
  sentenceCaseSubject,
} from '@/lib/spam-content-filter';

export type DeliverabilityCheck = {
  id: string;
  level: 'pass' | 'warn' | 'fail';
  title: string;
  detail: string;
};

function uppercaseRatio(value: string) {
  const letters = value.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

function htmlToPlainText(html: string) {
  return html
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeCampaignSubject(subject: string) {
  const scrubbed = scrubSpamFromText(subject);
  return sentenceCaseSubject(scrubbed.text).replace(/!{2,}/g, '!').slice(0, 180);
}

export function sanitizeCampaignHtml(html: string) {
  const withoutScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .trim()
    .slice(0, 100000);
  return scrubSpamFromHtml(withoutScripts).text;
}

export function runCampaignDeliverabilityChecks(options: {
  subject: string;
  previewText?: string;
  htmlBody: string;
  recipientCount: number;
  hasActiveSmtp: boolean;
  fromEmail?: string;
}) {
  const subjectScrub = scrubSpamFromText(options.subject);
  const htmlScrub = scrubSpamFromHtml(
    options.htmlBody
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .trim()
      .slice(0, 100000),
  );
  const subject = sentenceCaseSubject(subjectScrub.text).replace(/!{2,}/g, '!').slice(0, 180);
  const htmlBody = htmlScrub.text;
  const plainText = htmlToPlainText(htmlBody).toLowerCase();
  const filteredPhrases = [...new Set([...subjectScrub.removed, ...htmlScrub.removed])];
  const remaining = findRemainingSpamPhrases(`${subject} ${plainText}`);
  const checks: DeliverabilityCheck[] = [];

  if (!options.hasActiveSmtp) {
    checks.push({
      id: 'smtp',
      level: 'fail',
      title: 'No active SMTP profile',
      detail: 'Add and test an SMTP account in Settings → SMTP Manager before sending.',
    });
  } else {
    checks.push({
      id: 'smtp',
      level: 'pass',
      title: 'SMTP profile ready',
      detail: options.fromEmail
        ? `Sending via ${options.fromEmail}`
        : 'An active SMTP account is configured.',
    });
  }

  if (!subject) {
    checks.push({
      id: 'subject-empty',
      level: 'fail',
      title: 'Subject line is required',
      detail: 'Add a clear subject before sending.',
    });
  } else if (subject.length > 78) {
    checks.push({
      id: 'subject-length',
      level: 'warn',
      title: 'Subject may be truncated in inbox',
      detail: `Keep subjects under 78 characters (current: ${subject.length}).`,
    });
  } else {
    checks.push({
      id: 'subject-length',
      level: 'pass',
      title: 'Subject length looks good',
      detail: `${subject.length} characters — fits most inbox previews.`,
    });
  }

  if (uppercaseRatio(subject) > 0.6) {
    checks.push({
      id: 'subject-caps',
      level: 'fail',
      title: 'Too many capital letters in subject',
      detail: 'Use sentence case. ALL CAPS subjects are often flagged as spam.',
    });
  } else {
    checks.push({
      id: 'subject-caps',
      level: 'pass',
      title: 'Subject casing looks natural',
      detail: 'Avoid shouting with all caps to improve inbox placement.',
    });
  }

  if (/[!?$]{3,}/.test(subject) || (subject.match(/!/g)?.length ?? 0) >= 3) {
    checks.push({
      id: 'subject-punctuation',
      level: 'fail',
      title: 'Subject has aggressive punctuation',
      detail: 'Remove repeated ! or ? marks — they trigger spam filters.',
    });
  } else {
    checks.push({
      id: 'subject-punctuation',
      level: 'pass',
      title: 'Subject punctuation is clean',
      detail: 'No spam-like punctuation patterns detected.',
    });
  }

  if (remaining.length > 0) {
    checks.push({
      id: 'spam-words',
      level: 'fail',
      title: 'Spam trigger phrase still present',
      detail: `Could not auto-clean: ${remaining.slice(0, 3).join(', ')}. Rephrase manually or use Clean spam words.`,
    });
  } else if (filteredPhrases.length > 0) {
    checks.push({
      id: 'spam-words',
      level: 'warn',
      title: 'Spam words auto-filtered',
      detail: `Will replace: ${filteredPhrases.slice(0, 5).join(', ')}${
        filteredPhrases.length > 5 ? '…' : ''
      }. Cleaned copy is sent.`,
    });
  } else {
    checks.push({
      id: 'spam-words',
      level: 'pass',
      title: 'No common spam trigger phrases',
      detail: 'Content avoids high-risk marketing spam words.',
    });
  }

  const hasPromoHero = /background:#f26522;padding:\s*(24|28)px/i.test(htmlBody);
  const ctaButtonCount = htmlBody.match(/display:inline-block;padding:14px/g)?.length ?? 0;
  if (hasPromoHero || ctaButtonCount > 1) {
    checks.push({
      id: 'gmail-promotions',
      level: 'warn',
      title: 'May land in Gmail Promotions',
      detail:
        'Heavy color blocks and multiple buttons look like marketing mail. Plain, text-first layouts reach Primary more often.',
    });
  } else if (ctaButtonCount === 1) {
    checks.push({
      id: 'gmail-promotions',
      level: 'warn',
      title: 'Bulk sends may still use Promotions in Gmail',
      detail: 'Use a conversational subject and simple layout for a better Primary inbox chance.',
    });
  } else {
    checks.push({
      id: 'gmail-promotions',
      level: 'pass',
      title: 'Layout looks inbox-friendly',
      detail: 'Simple formatting without promo banners helps Primary inbox placement.',
    });
  }

  if (!htmlBody.trim()) {
    checks.push({
      id: 'html-empty',
      level: 'fail',
      title: 'No email template selected',
      detail: 'Choose an imported HTML template from the dropdown before sending.',
    });
  } else if (plainText.length < 40) {
    checks.push({
      id: 'html-text',
      level: 'warn',
      title: 'Very little readable text',
      detail: 'Image-only emails often land in spam. Add clear text content.',
    });
  } else {
    checks.push({
      id: 'html-text',
      level: 'pass',
      title: 'Email body has readable text',
      detail: `${plainText.length} characters of plain text detected.`,
    });
  }

  if (/<script\b/i.test(options.htmlBody)) {
    checks.push({
      id: 'html-script',
      level: 'fail',
      title: 'Script tags are not allowed',
      detail: 'Remove script tags — they are stripped on send and hurt deliverability.',
    });
  }

  if (options.recipientCount < 1) {
    checks.push({
      id: 'recipients',
      level: 'fail',
      title: 'No recipients selected',
      detail: 'Choose a contact list with subscribed contacts.',
    });
  } else {
    checks.push({
      id: 'recipients',
      level: 'pass',
      title: 'Recipients selected',
      detail: `${options.recipientCount} contact(s) on the selected list.`,
    });
  }

  checks.push({
    id: 'unsubscribe',
    level: 'pass',
    title: 'Unsubscribe handled in template',
    detail: 'Put your own unsubscribe link in the imported HTML template. The app will not inject an Inbox Flow unsubscribe URL.',
  });

  checks.push({
    id: 'plain-text',
    level: 'pass',
    title: 'Plain-text version included',
    detail: 'HTML and plain text are sent together for better deliverability.',
  });

  checks.push({
    id: 'rate-limit',
    level: 'pass',
    title: 'Send throttling enabled',
    detail: 'Emails go out one by one: batches of 10, then a pause — like a real mail client.',
  });

  const failures = checks.filter((c) => c.level === 'fail');
  const warnings = checks.filter((c) => c.level === 'warn');

  return {
    checks,
    canSend: failures.length === 0,
    failures,
    warnings,
    sanitizedSubject: subject,
    sanitizedHtml: htmlBody,
    filteredSpamPhrases: filteredPhrases,
  };
}
