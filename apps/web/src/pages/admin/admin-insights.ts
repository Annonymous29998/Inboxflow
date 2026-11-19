import { isUserOnline } from '@/lib/presence';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const STALE_MS = 30 * 60 * 1000;

export type InsightUser = {
  id: string;
  email: string;
  username?: string;
  firstName?: string;
  status: string;
  lastLoginAt?: string | null;
  onDevice?: boolean;
  adminNote?: string;
  organization?: { name: string } | null;
  subscription?: {
    status: string;
    currentPeriodEnd: string;
    active?: boolean;
  } | null;
  pulse?: {
    lastSeenAt?: string | null;
    emailsSent?: number;
    emailsFailed?: number;
    recentCampaigns?: Array<{
      id?: string;
      name?: string;
      updatedAt: string;
      sentCount: number;
      openedCount?: number;
      status?: string;
      organization?: { name: string } | null;
      user?: { username?: string; name?: string; email?: string } | null;
    }>;
  };
};

export function usernameOf(u: { username?: string; firstName?: string; email?: string }) {
  return u.username || u.firstName || String(u.email || '').split('@')[0] || u.email || 'user';
}

export function subActive(sub?: InsightUser['subscription']) {
  if (!sub) return false;
  if (sub.active === false) return false;
  const end = Date.parse(sub.currentPeriodEnd);
  return Number.isFinite(end) && end > Date.now() && sub.status !== 'EXPIRED' && sub.status !== 'CANCELLED';
}

export function subEndingSoon(sub?: InsightUser['subscription']) {
  if (!subActive(sub) || !sub) return false;
  const end = Date.parse(sub.currentPeriodEnd);
  return end - Date.now() < WEEK_MS;
}

export function isStaleDevice(u: InsightUser) {
  if (!u.onDevice) return false;
  const seen = u.pulse?.lastSeenAt || u.lastLoginAt;
  if (!seen) return true;
  const at = Date.parse(seen);
  return !Number.isFinite(at) || Date.now() - at > STALE_MS;
}

export function sentInWindow(u: InsightUser, withinMs: number) {
  let sent = 0;
  for (const c of u.pulse?.recentCampaigns || []) {
    const at = Date.parse(c.updatedAt);
    if (Number.isFinite(at) && Date.now() - at < withinMs) sent += c.sentCount || 0;
  }
  return sent;
}

export function residencyLabel(u: InsightUser) {
  if (isStaleDevice(u)) return 'Stale PC';
  if (u.onDevice) return 'On PC';
  return 'Cloud';
}

export function buildInsights(users: InsightUser[]) {
  const paid = users.filter((u) => subActive(u.subscription));
  const ending = users.filter((u) => subEndingSoon(u.subscription));
  const ended = users.filter((u) => !subActive(u.subscription));
  const online = users.filter((u) => isUserOnline(u.pulse?.lastSeenAt));
  const onDevice = users.filter((u) => u.onDevice);
  const cloud = users.filter((u) => !u.onDevice);
  const stale = users.filter((u) => isStaleDevice(u));

  const attention = users
    .map((u) => {
      const reasons: string[] = [];
      if (u.status === 'SUSPENDED') reasons.push('Deactivated');
      if (!subActive(u.subscription)) reasons.push('Subscription ended');
      else if (subEndingSoon(u.subscription)) reasons.push('Ends this week');
      if ((u.pulse?.emailsFailed || 0) >= 50) reasons.push('High failures');
      if (isStaleDevice(u)) reasons.push('PC offline');
      return { user: u, reasons };
    })
    .filter((row) => row.reasons.length);

  const sent24h = users.reduce((n, u) => n + sentInWindow(u, DAY_MS), 0);
  const sent7d = users.reduce((n, u) => n + sentInWindow(u, WEEK_MS), 0);
  const failed = users.reduce((n, u) => n + (u.pulse?.emailsFailed || 0), 0);
  const accepted = users.reduce((n, u) => n + (u.pulse?.emailsSent || 0), 0);
  const worst = [...users].sort((a, b) => (b.pulse?.emailsFailed || 0) - (a.pulse?.emailsFailed || 0))[0];
  const sendRows = [...users].sort(
    (a, b) =>
      (b.pulse?.emailsFailed || 0) - (a.pulse?.emailsFailed || 0) || sentInWindow(b, WEEK_MS) - sentInWindow(a, WEEK_MS),
  );

  return {
    paid: paid.length,
    ending: ending.length,
    ended: ended.length,
    online,
    onDevice: onDevice.length,
    cloud: cloud.length,
    stale: stale.length,
    onDeviceUsers: onDevice,
    cloudUsers: cloud,
    staleUsers: stale,
    attention,
    sendRows,
    sent24h,
    sent7d,
    failed,
    accepted,
    worstWorkspace: worst && (worst.pulse?.emailsFailed || 0) > 0 ? worst : null,
  };
}

export { DAY_MS, WEEK_MS };
