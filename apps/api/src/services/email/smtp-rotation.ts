import { prisma } from '../../config/prisma.js';
import { isSqliteDatabase } from '../../config/db-kind.js';
import type { EmailProvider } from '@prisma/client';
import { writeSystemLog } from '../system-log.js';
import { parseProviderConfig } from './providers.js';

let sqliteLimitTables = false;
async function ensureSqliteLimitTables() {
  if (!isSqliteDatabase() || sqliteLimitTables) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SmtpHourlySent" (
      provider_id TEXT NOT NULL,
      hour_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider_id, hour_key)
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SmtpMinuteSent" (
      provider_id TEXT NOT NULL,
      minute_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider_id, minute_key)
    )
  `);
  sqliteLimitTables = true;
}

export type RotationMode = 'failover' | 'round_robin' | 'weighted' | 'performance';

export type SmtpRotationSettings = {
  /** When true, pick across active SMTPs (respecting limits). When false, prefer campaign provider then failover. */
  enabled: boolean;
  mode: RotationMode;
};

export const DEFAULT_SMTP_ROTATION: SmtpRotationSettings = {
  enabled: true,
  mode: 'round_robin',
};

type OrgSendSettings = {
  smtpRotation?: Partial<SmtpRotationSettings>;
  rotationCursor?: number;
  fromRotateCursors?: Record<string, number>;
  [key: string]: unknown;
};

export function parseRotationSettings(sendSettings: unknown): SmtpRotationSettings {
  const raw = (sendSettings || {}) as OrgSendSettings;
  const mode = raw.smtpRotation?.mode;
  return {
    enabled: raw.smtpRotation?.enabled ?? DEFAULT_SMTP_ROTATION.enabled,
    mode:
      mode === 'failover' ||
      mode === 'round_robin' ||
      mode === 'weighted' ||
      mode === 'performance'
        ? mode
        : DEFAULT_SMTP_ROTATION.mode,
  };
}

function hourKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`;
}

function minuteKey() {
  const d = new Date();
  return `${hourKey()}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export async function getHourlySent(providerId: string): Promise<number> {
  try {
    await ensureSqliteLimitTables();
    const hk = hourKey();
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM "SmtpHourlySent"
      WHERE provider_id = ${providerId} AND hour_key = ${hk}
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export async function getMinuteSent(providerId: string): Promise<number> {
  try {
    await ensureSqliteLimitTables();
    const mk = minuteKey();
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM "SmtpMinuteSent"
      WHERE provider_id = ${providerId} AND minute_key = ${mk}
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

export async function incrementHourlySent(providerId: string) {
  try {
    await ensureSqliteLimitTables();
    const hk = hourKey();
    if (isSqliteDatabase()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "SmtpHourlySent" (provider_id, hour_key, count, updated_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT (provider_id, hour_key)
         DO UPDATE SET count = count + 1, updated_at = datetime('now')`,
        providerId,
        hk,
      );
      return;
    }
    await prisma.$executeRaw`
      INSERT INTO "SmtpHourlySent" (provider_id, hour_key, count, updated_at)
      VALUES (${providerId}, ${hk}, 1, NOW())
      ON CONFLICT (provider_id, hour_key)
      DO UPDATE SET count = "SmtpHourlySent".count + 1, updated_at = NOW()
    `;
  } catch {
    // optional limit tracking
  }
}

export async function incrementMinuteSent(providerId: string) {
  try {
    await ensureSqliteLimitTables();
    const mk = minuteKey();
    if (isSqliteDatabase()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "SmtpMinuteSent" (provider_id, minute_key, count, updated_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT (provider_id, minute_key)
         DO UPDATE SET count = count + 1, updated_at = datetime('now')`,
        providerId,
        mk,
      );
      return;
    }
    await prisma.$executeRaw`
      INSERT INTO "SmtpMinuteSent" (provider_id, minute_key, count, updated_at)
      VALUES (${providerId}, ${mk}, 1, NOW())
      ON CONFLICT (provider_id, minute_key)
      DO UPDATE SET count = "SmtpMinuteSent".count + 1, updated_at = NOW()
    `;
  } catch {
    // optional
  }
}

export function providerSuccessRate(p: EmailProvider): number {
  const ok = Number((p as EmailProvider & { successCount?: number }).successCount ?? 0);
  const fail = Number((p as EmailProvider & { failCount?: number }).failCount ?? 0);
  const total = ok + fail;
  if (total <= 0) return 0.5; // neutral until we have data
  return ok / total;
}

export async function filterBySendingLimits(providers: EmailProvider[]): Promise<EmailProvider[]> {
  const out: EmailProvider[] = [];
  for (const p of providers) {
    if (p.dailyLimit != null && p.sentToday >= p.dailyLimit) continue;
    if (p.hourlyLimit != null) {
      const hourly = await getHourlySent(p.id);
      if (hourly >= p.hourlyLimit) continue;
    }
    const minuteLimit = (p as EmailProvider & { minuteLimit?: number | null }).minuteLimit;
    if (minuteLimit != null) {
      const minute = await getMinuteSent(p.id);
      if (minute >= minuteLimit) continue;
    }
    out.push(p);
  }
  return out;
}

/** Weighted shuffle: higher priority ≈ more chances. */
function weightedOrder(providers: EmailProvider[]): EmailProvider[] {
  const pool: EmailProvider[] = [];
  for (const p of providers) {
    const weight = Math.max(1, p.priority || 1);
    for (let i = 0; i < weight; i += 1) pool.push(p);
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const seen = new Set<string>();
  const ordered: EmailProvider[] = [];
  for (const p of pool) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    ordered.push(p);
  }
  for (const p of providers) {
    if (!seen.has(p.id)) ordered.push(p);
  }
  return ordered;
}

/** Prefer SMTPs with higher historical success rate, then priority. */
function performanceOrder(providers: EmailProvider[]): EmailProvider[] {
  return [...providers].sort((a, b) => {
    const rateDiff = providerSuccessRate(b) - providerSuccessRate(a);
    if (Math.abs(rateDiff) > 0.001) return rateDiff;
    return (
      Number(b.isDefault) - Number(a.isDefault) ||
      b.priority - a.priority ||
      b.sentToday - a.sentToday
    );
  });
}

async function nextRoundRobinIndex(organizationId: string, modulo: number): Promise<number> {
  if (modulo <= 0) return 0;
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const settings = (org?.sendSettings || {}) as OrgSendSettings;
  const cursor = Number(settings.rotationCursor || 0);
  const next = (cursor + 1) % modulo;
  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      sendSettings: { ...settings, rotationCursor: next } as object,
    },
  });
  return cursor % modulo;
}

/** Round-robin SMTPs × per-SMTP From slots: SMTP1 From1 … SMTPn From1, then From2, wrap. */
export function smtpFromRotationGrid(
  smtpCount: number,
  fromCount: number,
  emailCount: number,
): Array<{ smtp: number; from: number }> {
  const nSmtp = Math.max(0, Math.floor(smtpCount));
  const nFrom = Math.max(0, Math.floor(fromCount));
  if (!nSmtp || !nFrom || emailCount <= 0) return [];
  const smtpCursors = Array.from({ length: nSmtp }, () => 0);
  let rr = 0;
  const out: Array<{ smtp: number; from: number }> = [];
  for (let i = 0; i < emailCount; i++) {
    const smtp = rr % nSmtp;
    rr += 1;
    const from = smtpCursors[smtp]! % nFrom;
    smtpCursors[smtp] = from + 1;
    out.push({ smtp: smtp + 1, from: from + 1 });
  }
  return out;
}

export function fromCursorSlot(cursor: number, modulo: number): { index: number; next: number } {
  if (modulo <= 0) return { index: 0, next: 0 };
  const c = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  return { index: c % modulo, next: (c + 1) % modulo };
}

async function loadFromRotateState(organizationId: string, providerId: string) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  const settings = (org?.sendSettings || {}) as OrgSendSettings;
  const map = { ...(settings.fromRotateCursors || {}) };
  const cursor = Number(map[providerId] || 0);
  return { settings, map, cursor: Number.isFinite(cursor) ? cursor : 0 };
}

let fromSlotChain: Promise<unknown> = Promise.resolve();

/** Take the next From slot and advance. Parallel sends on one PC cannot share a slot. */
export async function reserveFromIdentityIndex(
  organizationId: string,
  providerId: string,
  modulo: number,
): Promise<number> {
  const run = fromSlotChain.then(async () => {
    if (modulo <= 0) return 0;
    const { settings, map, cursor } = await loadFromRotateState(organizationId, providerId);
    const slot = fromCursorSlot(cursor, modulo);
    map[providerId] = slot.next;
    await prisma.organization.update({
      where: { id: organizationId },
      data: { sendSettings: { ...settings, fromRotateCursors: map } as object },
    });
    return slot.index;
  });
  fromSlotChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Current From slot for this SMTP (does not advance — commit after a successful send). */
export async function peekFromIdentityIndex(
  organizationId: string,
  providerId: string,
  modulo: number,
): Promise<number> {
  if (modulo <= 0) return 0;
  const { cursor } = await loadFromRotateState(organizationId, providerId);
  return fromCursorSlot(cursor, modulo).index;
}

/** Advance this SMTP’s From cursor after the message was accepted. */
export async function commitFromIdentityIndex(
  organizationId: string,
  providerId: string,
  modulo: number,
): Promise<void> {
  if (modulo <= 0) return;
  const { settings, map, cursor } = await loadFromRotateState(organizationId, providerId);
  map[providerId] = fromCursorSlot(cursor, modulo).next;
  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      sendSettings: { ...settings, fromRotateCursors: map } as object,
    },
  });
}

/**
 * Build ordered SMTP/API provider list for one send attempt.
 */
export type SendChannel = 'smtp' | 'api';

function isApiKeyProvider(p: EmailProvider) {
  if (p.type !== 'SMTP') return true;
  try {
    return parseProviderConfig(p.config).viaApiKey === 'true';
  } catch {
    return false;
  }
}

function providerMatchesChannel(p: EmailProvider, channel?: SendChannel | null) {
  if (!channel) return true;
  if (channel === 'smtp') return p.type === 'SMTP' && !isApiKeyProvider(p);
  return isApiKeyProvider(p);
}

export async function resolveRotatedProviders(input: {
  organizationId: string;
  preferredProviderId?: string | null;
  rotation?: SmtpRotationSettings;
  smtpOnly?: boolean;
  sendChannel?: SendChannel | null;
}): Promise<EmailProvider[]> {
  const rotation = input.rotation ?? DEFAULT_SMTP_ROTATION;

  const all = await prisma.emailProvider.findMany({
    where: {
      organizationId: input.organizationId,
      isActive: true,
      ...(input.smtpOnly ? { type: 'SMTP' } : {}),
    },
    orderBy: [{ priority: 'desc' }, { isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  const preferredRow = input.preferredProviderId
    ? all.find((p) => p.id === input.preferredProviderId)
    : undefined;
  const sendChannel: SendChannel | null =
    input.sendChannel ||
    (preferredRow ? (preferredRow.type === 'SMTP' ? 'smtp' : 'api') : input.smtpOnly ? 'smtp' : null);

  const channelPool = sendChannel ? all.filter((p) => providerMatchesChannel(p, sendChannel)) : all;

  let eligible = await filterBySendingLimits(channelPool);

  if (!eligible.length && channelPool.length) eligible = channelPool;

  if (!eligible.length) return [];

  // Campaign pinned to one SMTP/API key → that profile first, others of the same channel as failover.
  // Auto-rotate (preferredProviderId null) → channel pool with round_robin / weighted / etc.
  if (input.preferredProviderId) {
    const preferred = eligible.find((p) => p.id === input.preferredProviderId);
    if (preferred) {
      return [preferred, ...eligible.filter((p) => p.id !== preferred.id)];
    }
  }

  if (!rotation.enabled) {
    return [...eligible].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || b.priority - a.priority,
    );
  }

  const working = eligible;

  if (rotation.mode === 'weighted') {
    return weightedOrder(working);
  }

  if (rotation.mode === 'performance') {
    return performanceOrder(working);
  }

  if (rotation.mode === 'failover') {
    return [...working].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || b.priority - a.priority,
    );
  }

  if (rotation.mode === 'round_robin') {
    const start = await nextRoundRobinIndex(input.organizationId, working.length);
    return [...working.slice(start), ...working.slice(0, start)];
  }

  return [...working].sort(
    (a, b) => Number(b.isDefault) - Number(a.isDefault) || b.priority - a.priority,
  );
}

export async function logRotationPick(
  organizationId: string,
  provider: EmailProvider,
  mode: RotationMode,
) {
  await writeSystemLog({
    organizationId,
    level: 'INFO',
    category: 'smtp',
    message: `SMTP rotation (${mode}) selected: ${provider.name}`,
    meta: { providerId: provider.id, priority: provider.priority },
  });
}

/** Suggest TLS/SSL settings from port (Kestrel-style autodetection). */
export function detectTlsFromPort(port: number | string): {
  port: number;
  encryption: 'SSL' | 'STARTTLS' | 'NONE';
  secure: boolean;
} {
  const p = Number(port) || 587;
  if (p === 465) return { port: 465, encryption: 'SSL', secure: true };
  if (p === 587 || p === 2525) return { port: p, encryption: 'STARTTLS', secure: false };
  if (p === 25) return { port: 25, encryption: 'NONE', secure: false };
  return { port: p, encryption: p === 465 ? 'SSL' : 'STARTTLS', secure: p === 465 };
}
