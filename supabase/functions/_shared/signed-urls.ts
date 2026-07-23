import { createHmac, timingSafeEqual } from 'node:crypto';

function secret(): string {
  const value = Deno.env.get('JWT_ACCESS_SECRET');
  if (!value) throw new Error('JWT_ACCESS_SECRET missing');
  return value;
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

export function isSafeRedirectUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function buildTrackBaseUrl(): string {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  return `${supabaseUrl}/functions/v1/email-track`;
}
