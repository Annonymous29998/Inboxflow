/** Missing numbers stay fast. A saved pause, gap, or cap is what the send uses. */
export const DEFAULT_BATCH_SIZE = 20;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 500;
export const DEFAULT_BATCH_PAUSE_MS = 0;
export const DEFAULT_BETWEEN_EMAIL_MS = 0;
export const DEFAULT_MAX_PER_MINUTE = 600;
export const MIN_MAX_PER_MINUTE = 1;
export const MAX_MAX_PER_MINUTE = 600;
export const MAX_BATCH_PAUSE_MS = 600_000;
export const MAX_BETWEEN_EMAIL_MS = 120_000;

export function normalizeMaxPerMinute(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_MAX_PER_MINUTE) return DEFAULT_MAX_PER_MINUTE;
  if (n > MAX_MAX_PER_MINUTE) return MAX_MAX_PER_MINUTE;
  return Math.round(n);
}

export type QueuePacing = {
  batchSize: number;
  batchPauseMs: number;
  betweenEmailMs: number;
  maxPerMinute: number;
  maxPerHour?: number;
  sendChannel?: 'smtp' | 'api';
  [key: string]: unknown;
};

function keepNonNegative(raw: unknown, fallback: number, max: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > max) return max;
  return Math.round(n);
}

/** Keep the pace saved on the campaign. Fill only the numbers that are missing. */
export function withRecommendedPacing(raw: unknown): QueuePacing {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sendChannel = o.sendChannel === 'api' || o.sendChannel === 'smtp' ? o.sendChannel : undefined;
  const hour = Number(o.maxPerHour);
  return {
    ...o,
    batchSize: normalizeBatchSize(o.batchSize ?? DEFAULT_BATCH_SIZE),
    batchPauseMs: keepNonNegative(o.batchPauseMs, DEFAULT_BATCH_PAUSE_MS, MAX_BATCH_PAUSE_MS),
    betweenEmailMs: keepNonNegative(o.betweenEmailMs, DEFAULT_BETWEEN_EMAIL_MS, MAX_BETWEEN_EMAIL_MS),
    maxPerMinute:
      o.maxPerMinute == null || o.maxPerMinute === ''
        ? DEFAULT_MAX_PER_MINUTE
        : normalizeMaxPerMinute(o.maxPerMinute),
    maxPerHour: Number.isFinite(hour) && hour > 0 ? Math.min(50_000, Math.round(hour)) : 4_800,
    ...(sendChannel ? { sendChannel } : {}),
  };
}

export function normalizeBatchSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
  if (n > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return Math.round(n);
}
