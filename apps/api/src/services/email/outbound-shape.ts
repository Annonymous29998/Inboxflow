/**
 * Turn a letter into a normal MIME body.
 * Repairs structure only: a full HTML document, real link schemes, and a plain-text part.
 * Does not rewrite destinations or add authentication headers.
 */

const HREF_RE = /\b(href|formaction)\s*=\s*(["'])([\s\S]*?)\2/gi;
const BARE_HREF_RE = /\bhref\s*=\s*(https?:\/\/[^\s>'"]+)/gi;

function decodeHref(raw: string) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .trim();
}

function repairHref(raw: string): string | null {
  let dest = decodeHref(raw);
  if (!dest) return null;
  if (dest.startsWith('{{') || dest.startsWith('{')) return dest;
  if (dest.startsWith('#')) return dest;
  if (/^(mailto|tel|sms|cid):/i.test(dest)) return dest;
  if (/^\/\//.test(dest)) dest = `https:${dest}`;
  if (/^www\./i.test(dest)) dest = `https://${dest}`;
  if (/^https?:\/\//i.test(dest)) return dest.replace(/\s+/g, '');
  if (dest.startsWith('/')) return dest;
  return null;
}

/** Drop empty or non-link hrefs and give www / protocol-relative links a real https address. */
export function repairHtmlLinks(html: string): string {
  let out = String(html || '').replace(/\s(?:href|formaction)\s*=\s*(["'])\s*\1/gi, '');
  out = out.replace(HREF_RE, (full, attr: string, quote: string, raw: string) => {
    const decoded = decodeHref(raw);
    const next = repairHref(raw);
    if (next == null) return '';
    if (next === decoded) return full;
    return `${attr}=${quote}${next.replace(/&/g, '&amp;')}${quote}`;
  });
  out = out.replace(BARE_HREF_RE, (_full, raw: string) => {
    const next = repairHref(raw);
    return next ? `href="${next}"` : '';
  });
  return out;
}

/** Fragment letters become a complete document with a charset. Full documents are left intact. */
export function ensureHtmlDocument(html: string): string {
  const source = String(html || '').trim();
  if (!source) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p></p></body></html>';
  }
  if (/<html[\s>]/i.test(source)) {
    if (/<meta[^>]+charset\s*=/i.test(source)) return source;
    if (/<head[^>]*>/i.test(source)) {
      return source.replace(/<head[^>]*>/i, (open) => `${open}<meta charset="utf-8">`);
    }
    return source.replace(/<html[^>]*>/i, (open) => `${open}<head><meta charset="utf-8"></head>`);
  }
  const inner = /<body[\s>]/i.test(source) ? source : `<body>${source}</body>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>${inner}</html>`;
}

export function htmlToPlainText(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shapeOutboundLetter(input: { subject: string; html: string; text?: string | null }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = String(input.subject || 'Update')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Update';
  const html = ensureHtmlDocument(repairHtmlLinks(input.html));
  let text = String(input.text || '').trim();
  if (!text || /<[^>]+>/.test(text)) text = htmlToPlainText(text || html);
  if (!text) text = htmlToPlainText(html);
  return { subject, html, text };
}
