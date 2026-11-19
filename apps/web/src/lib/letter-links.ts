/** Scan letter HTML for CTA / anchor targets the user can remap to their own redirect. */

const HREF_RE = /\b(?:href|formaction)\s*=\s*(["'])([\s\S]*?)\1/gi;

function decodeHref(raw: string) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

export function isHttpUrl(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function detectLetterLinks(html: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const re = new RegExp(HREF_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let dest = decodeHref(m[2] || '');
    if (!dest || dest.startsWith('#') || dest.startsWith('{{') || dest.startsWith('{')) continue;
    if (/^(mailto|tel|sms|javascript|data|cid):/i.test(dest)) continue;
    if (/\/api\/t\/unsubscribe\b/i.test(dest)) continue;
    if (/^\/\//.test(dest)) dest = `https:${dest}`;
    if (/^www\./i.test(dest)) dest = `https://${dest}`;
    if (!isHttpUrl(dest)) continue;
    if (seen.has(dest)) continue;
    seen.add(dest);
    order.push(dest);
  }
  return order;
}

export function replaceLetterHref(html: string, from: string, to: string) {
  const next = String(to || '').trim();
  if (!from || !next || from === next || !isHttpUrl(next)) return html;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(\\b(?:href|formaction)\\s*=\\s*)(["'])${esc}\\2`, 'gi');
  return html.replace(re, `$1$2${next}$2`);
}
