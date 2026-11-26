import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cloudTrackingOrigin } from './public-url.js';

type SavedSession = {
  authorization: string;
  refreshToken: string;
  updatedAt: number;
};

const byOrg = new Map<string, SavedSession>();
let loaded = false;
let refreshFlight: Promise<string | null> | null = null;

function sessionPath(): string | null {
  const override = String(process.env.DESKTOP_CLOUD_SESSION_FILE || '').trim();
  if (override) return override;
  const db = String(process.env.DATABASE_URL || '');
  if (!db.startsWith('file:')) return null;
  const file = decodeURIComponent(db.slice('file:'.length).split('?')[0] || '');
  if (!file) return null;
  return path.join(path.dirname(file), 'cloud-session.json');
}

function loadSessions() {
  if (loaded) return;
  loaded = true;
  const file = sessionPath();
  if (!file) return;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, SavedSession>;
    for (const [org, row] of Object.entries(parsed)) {
      if (!row || typeof row.authorization !== 'string') continue;
      byOrg.set(org, {
        authorization: row.authorization,
        refreshToken: String(row.refreshToken || ''),
        updatedAt: Number(row.updatedAt) || 0,
      });
    }
  } catch {
    /* first launch has no saved sign-in */
  }
}

function persistSessions() {
  const file = sessionPath();
  if (!file) return;
  const body: Record<string, SavedSession> = {};
  for (const [org, row] of byOrg) body[org] = row;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  } catch {
    /* the in-memory copy still signs this run */
  }
}

export function accessTokenExpiry(authorization: string | null | undefined): number {
  const raw = String(authorization || '').replace(/^bearer\s+/i, '').trim();
  const part = raw.split('.')[1];
  if (!part) return 0;
  try {
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function bearer(accessToken: string): string {
  const token = accessToken.trim();
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

/** Keep the signed-in cloud session. A newer access token wins over an older one. */
export function rememberCloudAuthorization(
  organizationId: string | null | undefined,
  authorization: string | null | undefined,
  refreshToken?: string | null,
) {
  loadSessions();
  const org = String(organizationId || '').trim();
  const header = String(authorization || '').trim();
  if (!org || !/^bearer\s+\S+/i.test(header)) return;
  const current = byOrg.get(org);
  const incomingExp = accessTokenExpiry(header);
  const currentExp = current ? accessTokenExpiry(current.authorization) : 0;
  if (current && currentExp > incomingExp + 5_000) return;
  byOrg.set(org, {
    authorization: header,
    refreshToken: String(refreshToken || current?.refreshToken || ''),
    updatedAt: Date.now(),
  });
  persistSessions();
}

export function cloudAuthorizationFor(organizationId: string | null | undefined): string | null {
  loadSessions();
  const org = String(organizationId || '').trim();
  return org ? byOrg.get(org)?.authorization || null : null;
}

export function cloudRefreshTokenFor(organizationId: string | null | undefined): string | null {
  loadSessions();
  const org = String(organizationId || '').trim();
  const token = org ? byOrg.get(org)?.refreshToken : '';
  return token || null;
}

export function newestCloudSession(): { organizationId: string; accessToken: string; refreshToken: string } | null {
  loadSessions();
  let best: { organizationId: string; row: SavedSession } | null = null;
  for (const [organizationId, row] of byOrg) {
    if (!best || row.updatedAt > best.row.updatedAt) best = { organizationId, row };
  }
  if (!best) return null;
  return {
    organizationId: best.organizationId,
    accessToken: best.row.authorization.replace(/^bearer\s+/i, ''),
    refreshToken: best.row.refreshToken,
  };
}

async function refreshOnce(organizationId: string): Promise<string | null> {
  loadSessions();
  const refreshToken = cloudRefreshTokenFor(organizationId);
  if (!refreshToken) return cloudAuthorizationFor(organizationId);
  const res = await fetch(`${cloudTrackingOrigin()}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return cloudAuthorizationFor(organizationId);
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) return cloudAuthorizationFor(organizationId);
  const header = bearer(data.accessToken);
  rememberCloudAuthorization(organizationId, header, data.refreshToken || refreshToken);
  return header;
}

/** One refresh at a time so four senders cannot revoke each other's sign-in. */
export function refreshCloudAuthorization(organizationId: string): Promise<string | null> {
  if (!refreshFlight) {
    refreshFlight = refreshOnce(organizationId).finally(() => {
      refreshFlight = null;
    });
  }
  return refreshFlight;
}

/** Use the saved sign-in. Refresh it before it expires, including while the screen is off. */
export async function ensureFreshCloudAuthorization(organizationId: string): Promise<string | null> {
  const current = cloudAuthorizationFor(organizationId);
  const exp = accessTokenExpiry(current);
  if (current && exp > Date.now() + 90_000) return current;
  try {
    return (await refreshCloudAuthorization(organizationId)) || current;
  } catch {
    return current;
  }
}
