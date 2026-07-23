/**
 * Auto-scrub common spam / promo trigger phrases from marketing email content.
 * Mirrors apps/api/src/modules/deliverability/spam-scrubber.ts for client-side use.
 */

export interface SpamFilterResult {
  text: string;
  removed: string[];
  changed: boolean;
}

const SPAM_REPLACEMENTS: Array<{ phrase: string; replaceWith: string }> = [
  { phrase: 'earn extra cash', replaceWith: 'grow your balance' },
  { phrase: 'once in a lifetime', replaceWith: 'available' },
  { phrase: 'what are you waiting for', replaceWith: '' },
  { phrase: 'no credit check', replaceWith: '' },
  { phrase: 'double your money', replaceWith: 'grow your balance' },
  { phrase: 'make money fast', replaceWith: 'manage your account' },
  { phrase: '100% free', replaceWith: 'included' },
  { phrase: '100 percent free', replaceWith: 'included' },
  { phrase: 'free money', replaceWith: 'account credit' },
  { phrase: 'cash bonus', replaceWith: 'account bonus' },
  { phrase: 'risk free', replaceWith: 'no pressure' },
  { phrase: 'risk-free', replaceWith: 'no pressure' },
  { phrase: 'no obligation', replaceWith: '' },
  { phrase: 'limited time offer', replaceWith: 'available now' },
  { phrase: 'limited time', replaceWith: 'available now' },
  { phrase: 'act now', replaceWith: 'when you are ready' },
  { phrase: 'buy now', replaceWith: 'view details' },
  { phrase: 'order now', replaceWith: 'view options' },
  { phrase: 'apply now', replaceWith: 'continue' },
  { phrase: 'call now', replaceWith: 'reach out' },
  { phrase: 'click here', replaceWith: 'open this link' },
  { phrase: 'click below', replaceWith: 'use the link below' },
  { phrase: 'exclusive deal', replaceWith: 'available option' },
  { phrase: 'best price', replaceWith: 'current price' },
  { phrase: 'lowest price', replaceWith: 'current price' },
  { phrase: 'special promotion', replaceWith: 'update' },
  { phrase: 'amazing deal', replaceWith: 'update' },
  { phrase: 'huge discount', replaceWith: 'current pricing' },
  { phrase: 'free!!!', replaceWith: 'included' },
  { phrase: 'congratulations', replaceWith: 'hello' },
  { phrase: 'you have won', replaceWith: 'you have an update' },
  { phrase: "you're a winner", replaceWith: 'you have an update' },
  { phrase: 'you are a winner', replaceWith: 'you have an update' },
  { phrase: 'instant access', replaceWith: 'account access' },
  { phrase: 'no cost', replaceWith: 'included' },
  { phrase: 'for free', replaceWith: 'included' },
  { phrase: 'winner', replaceWith: 'update' },
  { phrase: 'urgent!!!', replaceWith: 'important' },
  { phrase: 'urgent!', replaceWith: 'important' },
  { phrase: 'urgent', replaceWith: 'important' },
  { phrase: 'guaranteed', replaceWith: 'supported' },
  { phrase: 'bargain', replaceWith: 'offer' },
  { phrase: '!!!', replaceWith: '!' },
  { phrase: '$$$', replaceWith: '' },
  { phrase: '!!', replaceWith: '!' },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(phrase: string) {
  const escaped = escapeRegExp(phrase);
  if (!/\s/.test(phrase) && /^[a-z0-9%-]+$/i.test(phrase)) {
    return new RegExp(`\\b${escaped}\\b`, 'gi');
  }
  return new RegExp(escaped, 'gi');
}

export function scrubSpamFromText(
  input: string,
  options: { trim?: boolean } = {},
): SpamFilterResult {
  const shouldTrim = options.trim !== false;
  let text = input;
  const removed: string[] = [];

  for (const { phrase, replaceWith } of SPAM_REPLACEMENTS) {
    const next = text.replace(phrasePattern(phrase), replaceWith);
    if (next === text) continue;
    removed.push(phrase);
    text = next;
  }

  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([.,;:!?)])/g, '$1');
  if (shouldTrim) text = text.trim();

  return {
    text,
    removed: [...new Set(removed.map((item) => item.toLowerCase()))],
    changed: text !== input,
  };
}

export function scrubSpamFromHtml(html: string): SpamFilterResult {
  const parts = html.split(/(<[^>]+>)/g);
  const removed: string[] = [];
  let changed = false;

  const scrubbed = parts
    .map((part) => {
      if (!part || part.startsWith('<')) return part;
      const result = scrubSpamFromText(part, { trim: false });
      if (result.removed.length) {
        removed.push(...result.removed);
        changed = true;
      }
      return result.text;
    })
    .join('');

  return {
    text: scrubbed,
    removed: [...new Set(removed)],
    changed: changed || scrubbed !== html,
  };
}

export function sentenceCaseSubject(subject: string) {
  const trimmed = subject.trim().replace(/\s+/g, ' ');
  if (!trimmed) return trimmed;

  const letters = trimmed.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return trimmed;

  const upperRatio = letters.replace(/[^A-Z]/g, '').length / letters.length;
  if (upperRatio <= 0.6) return trimmed;

  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function findRemainingSpamPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  const remaining: string[] = [];
  for (const { phrase } of SPAM_REPLACEMENTS) {
    if (/^[!$]+$/.test(phrase)) continue;
    const pattern = phrasePattern(phrase);
    pattern.lastIndex = 0;
    if (pattern.test(lower)) remaining.push(phrase.toLowerCase());
  }
  return [...new Set(remaining)];
}

export function scrubCampaignEditorContent(input: {
  subject?: string;
  previewText?: string;
  htmlContent: string;
  plainTextContent?: string;
}) {
  const subjectScrub = scrubSpamFromText(
    sentenceCaseSubject(input.subject || '').replace(/!{2,}/g, '!'),
  );
  const previewScrub = scrubSpamFromText(input.previewText || '');
  const htmlScrub = scrubSpamFromHtml(
    input.htmlContent
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .trim(),
  );
  const textScrub = scrubSpamFromText(input.plainTextContent || '', { trim: false });

  const removed = [
    ...new Set([
      ...subjectScrub.removed,
      ...previewScrub.removed,
      ...htmlScrub.removed,
      ...textScrub.removed,
    ]),
  ];

  return {
    subject: subjectScrub.text.slice(0, 180),
    previewText: previewScrub.text,
    htmlContent: htmlScrub.text,
    plainTextContent: textScrub.text,
    removed,
    changed:
      subjectScrub.changed || previewScrub.changed || htmlScrub.changed || textScrub.changed,
  };
}
