import { isSafeRedirectUrl } from '../../utils/signed-urls.js';

const HREF_RE = /\b(href|formaction)\s*=\s*(["'])([\s\S]*?)\2/gi;

function decodeHref(raw: string) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

function canonicalHref(raw: string) {
  let dest = decodeHref(raw);
  if (/^\/\//.test(dest)) dest = `https:${dest}`;
  if (/^www\./i.test(dest)) dest = `https://${dest}`;
  return dest;
}

/** Replace scanned letter hrefs with the operator’s own redirect URLs. */
export function applyLinkRedirectMap(
  html: string,
  map: Record<string, string> | null | undefined,
): string {
  if (!map || !Object.keys(map).length) return String(html || '');
  return String(html || '').replace(HREF_RE, (full, attr: string, quote: string, raw: string) => {
    const dest = canonicalHref(raw);
    const next = String(map[dest] || map[raw] || '').trim();
    if (!next || !isSafeRedirectUrl(next)) return full;
    return `${attr}=${quote}${next}${quote}`;
  });
}

export function applyLinkRedirectMapText(
  text: string,
  map: Record<string, string> | null | undefined,
): string {
  let out = String(text || '');
  if (!map) return out;
  for (const [from, to] of Object.entries(map)) {
    const next = String(to || '').trim();
    if (!from || !next || !isSafeRedirectUrl(next)) continue;
    out = out.split(from).join(next);
  }
  return out;
}
