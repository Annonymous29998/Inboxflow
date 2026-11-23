import { encodeClickTicket, isSafeRedirectUrl } from '../../utils/signed-urls.js';

const QUOTED_HREF_RE = /\b(href|formaction)\s*=\s*(["'])([\s\S]*?)\2/gi;
const BARE_HREF_RE = /\bhref\s*=\s*(https?:\/\/[^\s>'"]+)/gi;
const TEXT_URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

function decodeHref(raw: string) {
  return String(raw || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

function alreadyTracked(url: string) {
  return /\/api\/t\/(c|go|unsubscribe)\b/i.test(url);
}

export function normalizeClickDest(raw: string): string | null {
  let u = decodeHref(raw);
  if (!u) return null;
  if (u.startsWith('{{') || u.startsWith('{')) return null;
  if (u.startsWith('#')) return null;
  if (/^(mailto|tel|sms|javascript|data|cid|file):/i.test(u)) return null;
  if (alreadyTracked(u)) return null;
  if (/^\/\//.test(u)) u = `https:${u}`;
  if (/^www\./i.test(u)) u = `https://${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  if (!isSafeRedirectUrl(u)) return null;
  return u;
}

export function clickRedirectUrl(
  origin: string,
  campaignId: string,
  contactId: string,
  dest: string,
) {
  const t = encodeClickTicket(campaignId, contactId, dest);
  const base = String(origin || '').replace(/\/$/, '');
  return `${base}/api/t/c/${campaignId}/${contactId}?t=${encodeURIComponent(t)}`;
}

export function wrapCampaignHtmlLinks(
  html: string,
  opts: { origin: string; campaignId: string; contactId: string },
) {
  let out = String(html || '');
  out = out.replace(QUOTED_HREF_RE, (full, attr: string, quote: string, raw: string) => {
    const dest = normalizeClickDest(raw);
    if (!dest) return full;
    return `${attr}=${quote}${clickRedirectUrl(opts.origin, opts.campaignId, opts.contactId, dest)}${quote}`;
  });
  out = out.replace(BARE_HREF_RE, (full, raw: string) => {
    const dest = normalizeClickDest(raw);
    if (!dest) return full;
    return `href="${clickRedirectUrl(opts.origin, opts.campaignId, opts.contactId, dest)}"`;
  });
  return out;
}

export function wrapCampaignTextLinks(
  text: string,
  opts: { origin: string; campaignId: string; contactId: string },
) {
  return String(text || '').replace(TEXT_URL_RE, (raw) => {
    const dest = normalizeClickDest(raw.replace(/[),.;]+$/g, ''));
    if (!dest) return raw;
    return clickRedirectUrl(opts.origin, opts.campaignId, opts.contactId, dest);
  });
}

export function wrapCampaignLinks(
  html: string,
  text: string,
  opts: { origin: string; campaignId: string; contactId: string },
) {
  return {
    html: wrapCampaignHtmlLinks(html, opts),
    text: wrapCampaignTextLinks(text, opts),
  };
}

export function listTrackableLinks(html: string, text: string): string[] {
  const found = new Set<string>();
  String(html || '').replace(QUOTED_HREF_RE, (_full, _attr: string, _quote: string, raw: string) => {
    const dest = normalizeClickDest(raw);
    if (dest) found.add(dest);
    return _full;
  });
  String(text || '').replace(TEXT_URL_RE, (raw) => {
    const dest = normalizeClickDest(raw.replace(/[),.;]+$/g, ''));
    if (dest) found.add(dest);
    return raw;
  });
  return [...found];
}

export function applyRelayClickTickets(
  html: string,
  text: string,
  tickets: Record<string, string>,
  opts: { origin: string; campaignId: string; contactId: string },
) {
  const swap = (raw: string) => {
    const dest = normalizeClickDest(raw);
    if (!dest) return null;
    const ticket = tickets[dest];
    if (!ticket) return null;
    const base = opts.origin.replace(/\/$/, '');
    return `${base}/api/t/c/${opts.campaignId}/${opts.contactId}?t=${encodeURIComponent(ticket)}`;
  };
  const nextHtml = String(html || '').replace(QUOTED_HREF_RE, (full, attr: string, quote: string, raw: string) => {
    const next = swap(raw);
    if (!next) return full;
    return `${attr}=${quote}${next}${quote}`;
  });
  const nextText = String(text || '').replace(TEXT_URL_RE, (raw) => {
    const trimmed = raw.replace(/[),.;]+$/g, '');
    const next = swap(trimmed);
    if (!next) return raw;
    return raw.replace(trimmed, next);
  });
  return { html: nextHtml, text: nextText };
}
