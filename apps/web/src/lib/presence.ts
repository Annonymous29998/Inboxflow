/** Created-user mailer posts /api/workspace/pulse about every 20–30s. */
export const ONLINE_WITHIN_MS = 2 * 60 * 1000;

export function isUserOnline(lastSeenAt?: string | null) {
  if (!lastSeenAt) return false;
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < ONLINE_WITHIN_MS;
}

export function formatLastSeen(iso?: string | null) {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function seenWithin(lastSeenAt?: string | null, lastLoginAt?: string | null, withinMs?: number) {
  const stamp = lastSeenAt || lastLoginAt;
  if (!stamp || !withinMs) return false;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at < withinMs;
}

export function presenceLabel(lastSeenAt?: string | null, lastLoginAt?: string | null) {
  if (isUserOnline(lastSeenAt)) return { online: true as const, text: 'Online' };
  const stamp = lastSeenAt || lastLoginAt || null;
  if (!stamp) return { online: false as const, text: 'Offline' };
  return { online: false as const, text: `Last seen ${formatLastSeen(stamp)}` };
}
