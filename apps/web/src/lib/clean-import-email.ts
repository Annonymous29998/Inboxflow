/**
 * Clean a pasted/uploaded token into a single email.
 * Strips trailing `.`, `.Read` / `Read`, and similar junk.
 */
const JUNK_TLDS = new Set(['read', 'unread', 'mailto', 'http', 'https', 'www']);

export function cleanImportEmail(raw: string): string | null {
  if (!raw?.trim()) return null;

  let s = raw.trim().toLowerCase();
  s = s.replace(/^["'\s<]+/, '').replace(/["'\s>]+$/, '');
  s = s.replace(/\(\s*\d+\s*\)\s*$/, '');
  s = s.replace(/(?:\.|_)?(?:un)?read$/i, '');
  s = s.replace(/[.\s,;:!?]+$/g, '');

  if (isValidEmailShape(s)) return finalizeLocalPart(s);

  const matches = [...s.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    let candidate = matches[i]![0];
    candidate = candidate.replace(/(?:\.|_)?(?:un)?read$/i, '');
    candidate = candidate.replace(/\.+$/g, '');
    if (isValidEmailShape(candidate)) return finalizeLocalPart(candidate);
  }

  return null;
}

function isValidEmailShape(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  if (JUNK_TLDS.has(tld)) return false;
  if (tld.length < 2) return false;
  return true;
}

function finalizeLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const phoneMatch = local.match(/^(.*?)(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})(.*)$/);
  if (phoneMatch) {
    const after = (phoneMatch[3] || '').replace(/^[^a-z0-9]+/i, '');
    if (after && /[a-z]/i.test(after)) local = after;
  }
  const out = `${local}@${domain}`;
  return isValidEmailShape(out) ? out : email;
}
