/** How long until the per-minute cap has room for one more send. One wait, not a repeating poll. */

const MINUTE_MS = 60_000;

export function msUntilMinuteSlot(
  sentAt: number[],
  reservedAt: number[],
  maxPerMinute: number,
  now: number,
): number {
  if (maxPerMinute <= 0) return 0;
  const stamps = [...sentAt, ...reservedAt].filter((t) => now - t < MINUTE_MS && t <= now).sort((a, b) => a - b);
  if (stamps.length < maxPerMinute) return 0;
  const blocking = stamps[stamps.length - maxPerMinute];
  if (!Number.isFinite(blocking)) return 0;
  // +25ms so the blocking row is outside the window on the next check.
  const wait = blocking + MINUTE_MS - now + 25;
  if (wait <= 0) return 0;
  return Math.min(MINUTE_MS, wait);
}

type Hold = { id: number; at: number };

const tails = new Map<string, Promise<void>>();
const holds = new Map<string, Hold[]>();
let holdSeq = 0;

function prune(campaignId: string, now: number): Hold[] {
  const kept = (holds.get(campaignId) || []).filter((hold) => now - hold.at < MINUTE_MS);
  if (kept.length) holds.set(campaignId, kept);
  else holds.delete(campaignId);
  return kept;
}

export function reservedMinuteTimes(campaignId: string, now = Date.now()): number[] {
  return prune(campaignId, now).map((hold) => hold.at);
}

export function reserveMinuteSlot(campaignId: string, at = Date.now()): Hold {
  const hold = { id: ++holdSeq, at };
  const kept = prune(campaignId, at);
  kept.push(hold);
  holds.set(campaignId, kept);
  return hold;
}

export function releaseMinuteSlot(campaignId: string, hold: Hold) {
  const kept = (holds.get(campaignId) || []).filter((row) => row.id !== hold.id);
  if (kept.length) holds.set(campaignId, kept);
  else holds.delete(campaignId);
}

/** One sender at a time decides the wait, so the other workers cannot restart the countdown. */
export async function withCampaignMinuteLock<T>(campaignId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(campaignId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.catch(() => undefined).then(() => gate);
  tails.set(campaignId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(campaignId) === tail) tails.delete(campaignId);
  }
}
