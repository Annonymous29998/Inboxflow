/** Product default: 10 emails per batch, then a pause. Never allow 5. */
export const DEFAULT_BATCH_SIZE = 10;
export const MIN_BATCH_SIZE = 10;
export const MAX_BATCH_SIZE = 20;

export function normalizeBatchSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_BATCH_SIZE) return DEFAULT_BATCH_SIZE;
  if (n > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return Math.round(n);
}
