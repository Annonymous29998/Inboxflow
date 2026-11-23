import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';

function secret(): string {
  return env.JWT_ACCESS_SECRET;
}

function hmac(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function signClickRedirect(campaignId: string, contactId: string, url: string): string {
  return hmac(`click|${campaignId}|${contactId}|${url}`);
}

export function verifyClickRedirect(
  campaignId: string,
  contactId: string,
  url: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  return safeEqual(signClickRedirect(campaignId, contactId, url), signature);
}

/** Opaque ticket: destination is encoded + HMAC so attackers cannot swap the CTA URL. */
export function encodeClickTicket(campaignId: string, contactId: string, url: string): string {
  const body = Buffer.from(
    JSON.stringify({ u: url, c: campaignId, k: contactId }),
    'utf8',
  ).toString('base64url');
  return `${body}.${hmac(`click-t|${body}`)}`;
}

export function decodeClickTicket(
  campaignId: string,
  contactId: string,
  ticket: string | undefined,
): string | null {
  const raw = String(ticket || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!sig || !safeEqual(hmac(`click-t|${body}`), sig)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u?: string;
      c?: string;
      k?: string;
    };
    if (parsed.c !== campaignId || parsed.k !== contactId) return null;
    const dest = String(parsed.u || '');
    if (!dest || !isSafeRedirectUrl(dest)) return null;
    return dest;
  } catch {
    return null;
  }
}

export function resolveClickDest(
  campaignId: string,
  contactId: string,
  q: { t?: string; u?: string; s?: string },
): string | null {
  const fromTicket = decodeClickTicket(campaignId, contactId, q.t);
  if (fromTicket) return fromTicket;
  const url = String(q.u || '');
  if (url && isSafeRedirectUrl(url) && verifyClickRedirect(campaignId, contactId, url, q.s)) return url;
  return null;
}

export function signUnsubscribe(contactId: string, campaignId?: string | null): string {
  return hmac(`unsub|${contactId}|${campaignId || ''}`);
}

export function signOpen(contactId: string, campaignId: string): string {
  return hmac(`open|${contactId}|${campaignId}`);
}

export function verifyOpen(
  contactId: string,
  campaignId: string,
  signature: string | undefined,
): boolean {
  if (!signature || !contactId || !campaignId) return false;
  return safeEqual(signOpen(contactId, campaignId), signature);
}

export function verifyUnsubscribe(
  contactId: string,
  campaignId: string | undefined,
  signature: string | undefined,
): boolean {
  if (!signature || !contactId) return false;
  return safeEqual(signUnsubscribe(contactId, campaignId), signature);
}

/** Signed on the public site. The PC asks for these; Gmail hits port 443, not the PC. */
export function signRelayOpen(orgId: string, contactId: string, campaignId: string): string {
  return hmac(`relay-open|${orgId}|${contactId}|${campaignId}`);
}

export function verifyRelayOpen(
  orgId: string,
  contactId: string,
  campaignId: string,
  signature: string | undefined,
): boolean {
  if (!signature || !orgId || !contactId || !campaignId) return false;
  return safeEqual(signRelayOpen(orgId, contactId, campaignId), signature);
}

export function signRelayUnsubscribe(orgId: string, contactId: string, campaignId: string): string {
  return hmac(`relay-unsub|${orgId}|${contactId}|${campaignId}`);
}

export function verifyRelayUnsubscribe(
  orgId: string,
  contactId: string,
  campaignId: string | undefined,
  signature: string | undefined,
): boolean {
  if (!signature || !orgId || !contactId || !campaignId) return false;
  return safeEqual(signRelayUnsubscribe(orgId, contactId, campaignId), signature);
}

export function encodeRelayClickTicket(
  orgId: string,
  campaignId: string,
  contactId: string,
  url: string,
): string {
  const body = Buffer.from(JSON.stringify({ u: url, c: campaignId, k: contactId, o: orgId }), 'utf8').toString(
    'base64url',
  );
  return `${body}.${hmac(`relay-click|${body}`)}`;
}

export function decodeRelayClickTicket(
  campaignId: string,
  contactId: string,
  ticket: string | undefined,
): { url: string; orgId: string } | null {
  const raw = String(ticket || '');
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!sig || !safeEqual(hmac(`relay-click|${body}`), sig)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u?: string;
      c?: string;
      k?: string;
      o?: string;
    };
    if (parsed.c !== campaignId || parsed.k !== contactId) return null;
    const dest = String(parsed.u || '');
    const orgId = String(parsed.o || '');
    if (!orgId || !dest || !isSafeRedirectUrl(dest)) return null;
    return { url: dest, orgId };
  } catch {
    return null;
  }
}

/** Only allow http(s) redirects to non-dangerous schemes; block javascript: data: etc. */
export function isSafeRedirectUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Block credentialed URLs that can confuse some clients
    if (u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

/** Block obvious SSRF targets for user-supplied SMTP hosts (except local JSON transport). */
export function isBlockedSmtpHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!h || h === 'json') return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') {
    return env.NODE_ENV === 'production';
  }
  if (
    /^(10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) ||
    h.endsWith('.local') ||
    h.endsWith('.internal')
  ) {
    return env.NODE_ENV === 'production';
  }
  return false;
}
