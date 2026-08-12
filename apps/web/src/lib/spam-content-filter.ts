/**
 * Auto-scrub spam / promo trigger phrases + risky HTML patterns from marketing email.
 * Mirrors apps/api/src/modules/deliverability/spam-scrubber.ts for client-side use.
 */

export interface SpamFilterResult {
  text: string;
  removed: string[];
  changed: boolean;
}

const SPAM_REPLACEMENTS: Array<{ phrase: string; replaceWith: string }> = [
  { phrase: 'earn extra cash', replaceWith: 'grow your balance' },
  { phrase: 'earn money online', replaceWith: 'manage your account' },
  { phrase: 'make money online', replaceWith: 'manage your account' },
  { phrase: 'make money fast', replaceWith: 'manage your account' },
  { phrase: 'make money', replaceWith: 'manage your account' },
  { phrase: 'get rich quick', replaceWith: 'plan ahead' },
  { phrase: 'get rich', replaceWith: 'plan ahead' },
  { phrase: 'double your income', replaceWith: 'grow your balance' },
  { phrase: 'double your money', replaceWith: 'grow your balance' },
  { phrase: 'double your', replaceWith: 'grow your' },
  { phrase: 'extra income', replaceWith: 'account update' },
  { phrase: 'passive income', replaceWith: 'account update' },
  { phrase: 'cash bonus', replaceWith: 'account bonus' },
  { phrase: 'cash prize', replaceWith: 'account update' },
  { phrase: 'free money', replaceWith: 'account credit' },
  { phrase: 'easy money', replaceWith: 'account update' },
  { phrase: 'fast cash', replaceWith: 'account update' },
  { phrase: 'wire transfer', replaceWith: 'bank transfer' },
  { phrase: 'bitcoin giveaway', replaceWith: 'account update' },
  { phrase: 'crypto giveaway', replaceWith: 'account update' },
  { phrase: 'crypto airdrop', replaceWith: 'account update' },
  { phrase: 'nft giveaway', replaceWith: 'account update' },
  { phrase: '100% free', replaceWith: 'included' },
  { phrase: '100 percent free', replaceWith: 'included' },
  { phrase: 'absolutely free', replaceWith: 'included' },
  { phrase: 'totally free', replaceWith: 'included' },
  { phrase: 'completely free', replaceWith: 'included' },
  { phrase: 'free!!!', replaceWith: 'included' },
  { phrase: 'free!!', replaceWith: 'included' },
  { phrase: 'free!', replaceWith: 'included' },
  { phrase: 'for free', replaceWith: 'included' },
  { phrase: 'free gift', replaceWith: 'included item' },
  { phrase: 'free trial', replaceWith: 'trial access' },
  { phrase: 'free access', replaceWith: 'account access' },
  { phrase: 'no cost', replaceWith: 'included' },
  { phrase: 'no fees', replaceWith: 'standard terms' },
  { phrase: 'no charge', replaceWith: 'included' },
  { phrase: 'without cost', replaceWith: 'included' },
  { phrase: 'once in a lifetime', replaceWith: 'available' },
  { phrase: 'what are you waiting for', replaceWith: '' },
  { phrase: 'limited time offer', replaceWith: 'available now' },
  { phrase: 'limited time only', replaceWith: 'available now' },
  { phrase: 'limited time', replaceWith: 'available now' },
  { phrase: 'limited offer', replaceWith: 'available now' },
  { phrase: 'act now!!!', replaceWith: 'when you are ready' },
  { phrase: 'act now!', replaceWith: 'when you are ready' },
  { phrase: 'act now', replaceWith: 'when you are ready' },
  { phrase: 'act immediately', replaceWith: 'when you are ready' },
  { phrase: 'do it today', replaceWith: 'when convenient' },
  { phrase: 'hurry up', replaceWith: 'take a look' },
  { phrase: 'hurry!', replaceWith: 'take a look' },
  { phrase: 'hurry', replaceWith: 'take a look' },
  { phrase: 'last chance', replaceWith: 'still available' },
  { phrase: 'final notice', replaceWith: 'friendly reminder' },
  { phrase: 'final warning', replaceWith: 'friendly reminder' },
  { phrase: 'expires today', replaceWith: 'available today' },
  { phrase: 'expires tonight', replaceWith: 'available today' },
  { phrase: 'expires in 24 hours', replaceWith: 'available for a limited period' },
  { phrase: 'expires soon', replaceWith: 'available now' },
  { phrase: 'only today', replaceWith: 'available now' },
  { phrase: 'today only', replaceWith: 'available now' },
  { phrase: 'must act', replaceWith: 'you can continue' },
  { phrase: 'immediate action required', replaceWith: 'please review when convenient' },
  { phrase: 'immediate action', replaceWith: 'please review' },
  { phrase: 'time sensitive', replaceWith: 'please review' },
  { phrase: 'urgent!!!', replaceWith: 'important' },
  { phrase: 'urgent!!', replaceWith: 'important' },
  { phrase: 'urgent!', replaceWith: 'important' },
  { phrase: 'urgent', replaceWith: 'important' },
  { phrase: 'asap', replaceWith: 'soon' },
  { phrase: "don't delete", replaceWith: 'please review' },
  { phrase: 'do not delete', replaceWith: 'please review' },
  { phrase: "don't miss out", replaceWith: 'take a look' },
  { phrase: 'do not miss out', replaceWith: 'take a look' },
  { phrase: 'while supplies last', replaceWith: 'while available' },
  { phrase: "before it's too late", replaceWith: 'when you have a moment' },
  { phrase: 'before its too late', replaceWith: 'when you have a moment' },
  { phrase: 'buy now!!!', replaceWith: 'view details' },
  { phrase: 'buy now!', replaceWith: 'view details' },
  { phrase: 'buy now', replaceWith: 'view details' },
  { phrase: 'order now', replaceWith: 'view options' },
  { phrase: 'shop now', replaceWith: 'view collection' },
  { phrase: 'apply now', replaceWith: 'continue' },
  { phrase: 'call now', replaceWith: 'reach out' },
  { phrase: 'sign up free', replaceWith: 'create an account' },
  { phrase: 'sign up now', replaceWith: 'create an account' },
  { phrase: 'subscribe now', replaceWith: 'stay updated' },
  { phrase: 'click here now', replaceWith: 'open this link' },
  { phrase: 'click here', replaceWith: 'open this link' },
  { phrase: 'click below', replaceWith: 'use the link below' },
  { phrase: 'click above', replaceWith: 'use the link above' },
  { phrase: 'click the link', replaceWith: 'open the link' },
  { phrase: 'tap here', replaceWith: 'open this link' },
  { phrase: 'exclusive deal', replaceWith: 'available option' },
  { phrase: 'exclusive offer', replaceWith: 'available option' },
  { phrase: 'special promotion', replaceWith: 'update' },
  { phrase: 'special offer', replaceWith: 'update' },
  { phrase: 'amazing deal', replaceWith: 'update' },
  { phrase: 'incredible offer', replaceWith: 'update' },
  { phrase: 'unbelievable deal', replaceWith: 'update' },
  { phrase: 'huge discount', replaceWith: 'current pricing' },
  { phrase: 'massive discount', replaceWith: 'current pricing' },
  { phrase: 'biggest sale', replaceWith: 'current pricing' },
  { phrase: 'best price', replaceWith: 'current price' },
  { phrase: 'lowest price', replaceWith: 'current price' },
  { phrase: 'lowest prices', replaceWith: 'current prices' },
  { phrase: 'price drop', replaceWith: 'updated pricing' },
  { phrase: 'slash prices', replaceWith: 'updated pricing' },
  { phrase: 'half off', replaceWith: 'current pricing' },
  { phrase: '50% off', replaceWith: 'current pricing' },
  { phrase: '70% off', replaceWith: 'current pricing' },
  { phrase: '90% off', replaceWith: 'current pricing' },
  { phrase: 'clearance', replaceWith: 'available items' },
  { phrase: 'bargain', replaceWith: 'offer' },
  { phrase: 'deal of the day', replaceWith: "today's update" },
  { phrase: 'hot deal', replaceWith: 'update' },
  { phrase: 'no obligation', replaceWith: '' },
  { phrase: 'no credit check', replaceWith: '' },
  { phrase: 'no questions asked', replaceWith: '' },
  { phrase: 'no catch', replaceWith: '' },
  { phrase: 'no strings attached', replaceWith: '' },
  { phrase: 'risk free', replaceWith: 'no pressure' },
  { phrase: 'risk-free', replaceWith: 'no pressure' },
  { phrase: 'satisfaction guaranteed', replaceWith: 'we are here to help' },
  { phrase: 'money back guarantee', replaceWith: 'support options' },
  { phrase: 'money-back guarantee', replaceWith: 'support options' },
  { phrase: 'full refund', replaceWith: 'support options' },
  { phrase: 'guaranteed', replaceWith: 'supported' },
  { phrase: 'increase sales', replaceWith: 'grow results' },
  { phrase: 'increase your sales', replaceWith: 'grow your results' },
  { phrase: 'congratulations!!!', replaceWith: 'hello' },
  { phrase: 'congratulations!', replaceWith: 'hello' },
  { phrase: 'congratulations', replaceWith: 'hello' },
  { phrase: 'you have been selected', replaceWith: 'you have an update' },
  { phrase: "you've been selected", replaceWith: 'you have an update' },
  { phrase: 'you have won', replaceWith: 'you have an update' },
  { phrase: "you've won", replaceWith: 'you have an update' },
  { phrase: "you're a winner", replaceWith: 'you have an update' },
  { phrase: 'you are a winner', replaceWith: 'you have an update' },
  { phrase: 'claim your prize', replaceWith: 'view your update' },
  { phrase: 'claim your reward', replaceWith: 'view your update' },
  { phrase: 'claim now', replaceWith: 'view update' },
  { phrase: 'winner', replaceWith: 'update' },
  { phrase: 'prize', replaceWith: 'update' },
  { phrase: 'lottery', replaceWith: 'selection' },
  { phrase: 'jackpot', replaceWith: 'update' },
  { phrase: 'verify immediately', replaceWith: 'please review' },
  { phrase: 'verify your account', replaceWith: 'review your account' },
  { phrase: 'confirm your identity', replaceWith: 'review your account' },
  { phrase: 'confirm your account', replaceWith: 'review your account' },
  { phrase: 'account suspended', replaceWith: 'account update' },
  { phrase: 'account will be suspended', replaceWith: 'account update' },
  { phrase: 'account locked', replaceWith: 'account update' },
  { phrase: 'your account has been locked', replaceWith: 'please review your account' },
  { phrase: 'your account has been compromised', replaceWith: 'please review your account' },
  { phrase: 'unusual activity detected', replaceWith: 'account activity notice' },
  { phrase: 'security alert', replaceWith: 'account notice' },
  { phrase: 'password expires', replaceWith: 'password reminder' },
  { phrase: 'update your payment', replaceWith: 'review billing details' },
  { phrase: 'payment failed', replaceWith: 'billing notice' },
  { phrase: 'invoice attached', replaceWith: 'billing details' },
  { phrase: 'this is not spam', replaceWith: '' },
  { phrase: 'this is not a scam', replaceWith: '' },
  { phrase: 'not spam', replaceWith: '' },
  { phrase: 'dear friend', replaceWith: 'hello' },
  { phrase: 'dear sir/madam', replaceWith: 'hello' },
  { phrase: 'dear valued customer', replaceWith: 'hello' },
  { phrase: 'as seen on tv', replaceWith: 'featured in' },
  { phrase: 'as seen on', replaceWith: 'featured in' },
  { phrase: 'instant access', replaceWith: 'account access' },
  { phrase: 'mlm', replaceWith: 'partner program' },
  { phrase: 'multi level marketing', replaceWith: 'partner program' },
  { phrase: 'work from home', replaceWith: 'remote work' },
  { phrase: 'be your own boss', replaceWith: 'grow independently' },
  { phrase: 'weight loss', replaceWith: 'wellness' },
  { phrase: 'lose weight', replaceWith: 'wellness goals' },
  { phrase: 'viagra', replaceWith: 'medication' },
  { phrase: 'cialis', replaceWith: 'medication' },
  { phrase: 'casino', replaceWith: 'entertainment' },
  { phrase: 'online pharmacy', replaceWith: 'health resources' },
  { phrase: '!!!', replaceWith: '!' },
  { phrase: '$$$', replaceWith: '' },
  { phrase: '$$', replaceWith: '' },
  { phrase: '!!', replaceWith: '!' },
];

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(phrase: string) {
  const escaped = escapeRegExp(phrase);
  if (!/\s/.test(phrase) && /^[a-z0-9%'-]+$/i.test(phrase)) {
    return new RegExp(`\\b${escaped}\\b`, 'gi');
  }
  return new RegExp(escaped, 'gi');
}

function decodeBasicEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, num: string) => {
      try {
        return String.fromCodePoint(Number(num));
      } catch {
        return '';
      }
    });
}

function deobfuscateSpacedLetters(input: string): string {
  return input.replace(/\b([A-Za-z])(?:[\s.\-_*]{1,2}([A-Za-z])){2,8}\b/g, (match) => {
    const letters = match.replace(/[^A-Za-z]/g, '');
    if (letters.length >= 3 && letters.length <= 12) return letters;
    return match;
  });
}

function softenAllCapsRun(text: string): string {
  return text.replace(/\b([A-Z][A-Z0-9]{3,})\b/g, (word) => {
    if (/^[A-Z0-9]+$/.test(word) && word.length >= 4) {
      return word.charAt(0) + word.slice(1).toLowerCase();
    }
    return word;
  });
}

export function scrubSpamFromText(
  input: string,
  options: { trim?: boolean } = {},
): SpamFilterResult {
  const shouldTrim = options.trim !== false;
  const original = input;
  let text = deobfuscateSpacedLetters(decodeBasicEntities(input));
  const removed: string[] = [];

  for (const { phrase, replaceWith } of SPAM_REPLACEMENTS) {
    const next = text.replace(phrasePattern(phrase), replaceWith);
    if (next === text) continue;
    removed.push(phrase);
    text = next;
  }

  text = softenAllCapsRun(text);
  text = text
    .replace(/!{2,}/g, '!')
    .replace(/\${2,}/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([.,;:!?)])/g, '$1');
  if (shouldTrim) text = text.trim();

  return {
    text,
    removed: [...new Set(removed.map((item) => item.toLowerCase()))],
    changed: text !== original,
  };
}

export function scrubSpamFromHtml(html: string): SpamFilterResult {
  const removed: string[] = [];
  let changed = false;
  let working = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, () => {
      changed = true;
      removed.push('script');
      return '';
    })
    .replace(/<!--[\s\S]*?-->/g, () => {
      changed = true;
      return '';
    })
    .replace(/\s*on\w+\s*=\s*("|')[\s\S]*?\1/gi, () => {
      changed = true;
      removed.push('inline-handler');
      return '';
    })
    .replace(/javascript:/gi, () => {
      changed = true;
      removed.push('javascript-url');
      return '';
    })
    .replace(/color\s*:\s*(#f{0,2}00|#ff0000|red|rgb\(\s*255\s*,\s*0\s*,\s*0\s*\))/gi, () => {
      changed = true;
      removed.push('spam-red-color');
      return 'color:#333333';
    })
    .replace(/font-size\s*:\s*(\d{2,})px/gi, (_m, size: string) => {
      const n = Number(size);
      if (n >= 28) {
        changed = true;
        removed.push('oversized-font');
        return 'font-size:18px';
      }
      return _m;
    });

  const parts = working.split(/(<[^>]+>)/g);
  const scrubbed = parts
    .map((part) => {
      if (!part || part.startsWith('<')) return part;
      const result = scrubSpamFromText(part, { trim: false });
      if (result.removed.length) {
        removed.push(...result.removed);
        changed = true;
      }
      if (result.text !== part) changed = true;
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
  if (upperRatio <= 0.45) return trimmed;

  const lower = trimmed.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function findRemainingSpamPhrases(text: string): string[] {
  const blocking = [
    'make money',
    'get rich',
    'free money',
    'this is not spam',
    'you have won',
    'claim your prize',
    'crypto giveaway',
    'double your money',
    '100% free',
    'no credit check',
    'dear friend',
    'viagra',
    'cialis',
    'online pharmacy',
  ];
  const lower = text.toLowerCase();
  const remaining: string[] = [];
  for (const phrase of blocking) {
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
  const htmlScrub = scrubSpamFromHtml(input.htmlContent.trim());
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
