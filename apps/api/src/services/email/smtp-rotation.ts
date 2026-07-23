import { prisma } from '../../config/prisma.js';
import type { EmailProvider } from '@prisma/client';
import { writeSystemLog } from '../system-log.js';

export type RotationMode = 'failover' | 'round_robin' | 'weighted';

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
  [key: string]: unknown;
};

export function parseRotationSettings(sendSettings: unknown): SmtpRotationSettings {
  const raw = (sendSettings || {}) as OrgSendSettings;
  return {
    enabled: raw.smtpRotation?.enabled ?? DEFAULT_SMTP_ROTATION.enabled,
    mode: raw.smtpRotation?.mode ?? DEFAULT_SMTP_ROTATION.mode,
  };
}

function hourKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`;
}

async function getHourlySent(providerId: string): Promise<number> {
  try {
    const hk = hourKey();
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count FROM "SmtpHourlySent"
      WHERE provider_id = ${providerId} AND hour_key = ${hk}
    `;
    return rows[0]?.count ?? 0;
  } catch {
    return 0;
  }
}

export async function incrementHourlySent(providerId: string) {
  try {
    const hk = hourKey();
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

export async function filterBySendingLimits(providers: EmailProvider[]): Promise<EmailProvider[]> {
  const out: EmailProvider[] = [];
  for (const p of providers) {
    if (p.dailyLimit != null && p.sentToday >= p.dailyLimit) continue;
    if (p.hourlyLimit != null) {
      const hourly = await getHourlySent(p.id);
      if (hourly >= p.hourlyLimit) continue;
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

/**
 * Build ordered SMTP/API provider list for one send attempt.
 * - fixed preferredId + rotation disabled → preferred first, then priority failover
 * - rotation enabled → round_robin / weighted / failover across eligible providers
 * Always filters out providers that hit daily/hourly limits.
 */
export async function resolveRotatedProviders(input: {
  organizationId: string;
  preferredProviderId?: string | null;
  rotation?: SmtpRotationSettings;
  /** If true, only SMTP type (rotation typically for SMTP accounts). */
  smtpOnly?: boolean;
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

  let eligible = await filterBySendingLimits(all);

  if (!eligible.length && all.length) eligible = all;

  if (!eligible.length) return [];

  if (!rotation.enabled && input.preferredProviderId) {
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

  let working = eligible;
  if (input.preferredProviderId && rotation.mode === 'failover') {
    const preferred = eligible.find((p) => p.id === input.preferredProviderId);
    if (preferred) {
      working = [preferred, ...eligible.filter((p) => p.id !== preferred.id)];
      return working;
    }
  }

  if (rotation.mode === 'weighted') {
    return weightedOrder(working);
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
