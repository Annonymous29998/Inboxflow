import { createHmac, timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';
import { hashToken } from '../utils/crypto.js';
import type { AuthUser } from '../utils/errors.js';

type HybridPayload = AuthUser & { sub?: string; exp?: number };

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function verifyHs256AccessToken(token: string, secret: string): HybridPayload | null {
  if (!secret || secret.length < 32) return null;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as HybridPayload;
    if (parsed.exp && Number(parsed.exp) * 1000 < Date.now()) return null;
    if (!parsed.sub && !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function verifyHybridAccessToken(token: string): HybridPayload | null {
  const secrets = [...new Set([env.JWT_ACCESS_SECRET, env.CLOUD_JWT_ACCESS_SECRET].filter((s) => s.length >= 32))];
  for (const secret of secrets) {
    const payload = verifyHs256AccessToken(token, secret);
    if (payload) return payload;
  }
  return null;
}

const cache = new Map<string, { user: HybridPayload; until: number }>();

function asUser(payload: HybridPayload): HybridPayload {
  const id = String(payload.sub || payload.id || '').trim();
  return {
    id,
    sub: id,
    email: String(payload.email || ''),
    role: String(payload.role || 'USER'),
    organizationId: String(payload.organizationId || ''),
    exp: payload.exp,
  };
}

async function introspectCloudMe(token: string): Promise<HybridPayload | null> {
  const base = String(process.env.REMOTE_APP_URL || '').replace(/\/$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  try {
    const res = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      user?: { id?: string; email?: string; role?: string; organizationId?: string };
    };
    const u = data.user;
    if (!u?.id) return null;
    return {
      id: u.id,
      sub: u.id,
      email: String(u.email || ''),
      role: String(u.role || 'USER'),
      organizationId: String(u.organizationId || ''),
    };
  } catch {
    return null;
  }
}

/** Verify hybrid desktop tokens: local HMAC, Lightsail HMAC, or Lightsail /api/auth/me. */
export async function resolveHybridPayload(token: string): Promise<HybridPayload | null> {
  const key = hashToken(token);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;

  const verified = verifyHybridAccessToken(token);
  if (verified) {
    const user = asUser(verified);
    cache.set(key, { user, until: Date.now() + 60_000 });
    return user;
  }

  const remote = await introspectCloudMe(token);
  if (!remote) return null;
  const user = asUser(remote);
  cache.set(key, { user, until: Date.now() + 60_000 });
  return user;
}
