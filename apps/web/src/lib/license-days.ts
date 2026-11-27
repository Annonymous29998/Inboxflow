/** Remaining whole days on a license. A partial day still counts as one. */
export function licenseDaysLeft(iso?: string | null): number | null {
  if (!iso) return null;
  const end = Date.parse(iso);
  if (!Number.isFinite(end)) return null;
  return Math.ceil((end - Date.now()) / 86_400_000);
}

export function licenseDaysLabel(iso?: string | null): { text: string; tone: 'ok' | 'soon' | 'ended' } | null {
  const days = licenseDaysLeft(iso);
  if (days == null) return null;
  if (days > 7) return { text: `${days} days left`, tone: 'ok' };
  if (days > 1) return { text: `${days} days left`, tone: 'soon' };
  if (days === 1) return { text: '1 day left', tone: 'soon' };
  if (days === 0) return { text: 'Ends today', tone: 'soon' };
  return { text: 'License ended', tone: 'ended' };
}
