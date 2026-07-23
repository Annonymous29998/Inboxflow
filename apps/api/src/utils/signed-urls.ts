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

export function signUnsubscribe(contactId: string, campaignId?: string | null): string {
  return hmac(`unsub|${contactId}|${campaignId || ''}`);
}

export function verifyUnsubscribe(
  contactId: string,
  campaignId: string | undefined,
  signature: string | undefined,
): boolean {
  if (!signature || !contactId) return false;
  return safeEqual(signUnsubscribe(contactId, campaignId), signature);
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
