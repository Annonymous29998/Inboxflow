/** Send as soon as SMTP accepts the previous message. No idle gap, no batch nap. */
export const DEFAULT_BATCH_SIZE = 20;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 500;
export const DEFAULT_BATCH_PAUSE_MS = 0;
export const DEFAULT_BETWEEN_EMAIL_MS = 0;
export const DEFAULT_MAX_PER_MINUTE = 600;
export const MIN_MAX_PER_MINUTE = 1;
export const MAX_MAX_PER_MINUTE = 600;

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

/** Apply the fast pace on every campaign. */
export function withRecommendedPacing(raw: unknown): QueuePacing {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const sendChannel = o.sendChannel === 'api' || o.sendChannel === 'smtp' ? o.sendChannel : undefined;
  const hour = Number(o.maxPerHour);
  return {
    ...o,
    batchSize: DEFAULT_BATCH_SIZE,
    batchPauseMs: DEFAULT_BATCH_PAUSE_MS,
    betweenEmailMs: DEFAULT_BETWEEN_EMAIL_MS,
    maxPerMinute: DEFAULT_MAX_PER_MINUTE,
    maxPerHour: Number.isFinite(hour) && hour > 0 ? Math.round(hour) : 4_800,
    ...(sendChannel ? { sendChannel } : {}),
  };
}

export function normalizeBatchSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
  if (n > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return Math.round(n);
}
