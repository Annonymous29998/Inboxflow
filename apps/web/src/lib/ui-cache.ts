/** Instant paint snapshots for list/dashboard screens. Always revalidate after. */

import { currentAccountId } from '@/lib/account-scope';

const PREFIX = 'inboxflow:snap:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Snap<T> = { t: number; v: T };

function accountPrefix(): string {
  return PREFIX + currentAccountId() + ':';
}

export function uiCacheGet<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(accountPrefix() + key);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snap<T>;
    if (!snap || typeof snap.t !== 'number' || snap.v === undefined) return null;
    if (Date.now() - snap.t > MAX_AGE_MS) {
      window.localStorage.removeItem(accountPrefix() + key);
      return null;
    }
    return snap.v;
  } catch {
    return null;
  }
}

export function uiCacheSet(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(accountPrefix() + key, JSON.stringify({ t: Date.now(), v: value }));
  } catch {
    /* quota / private mode */
  }
}

export function uiCacheRemove(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(accountPrefix() + key);
  } catch {
    /* ignore */
  }
}

/** Drop campaign list snapshots so a new draft is not hidden behind a stale first page. */
export function uiCacheInvalidateCampaigns(): void {
  if (typeof window === 'undefined') return;
  try {
    const prefix = accountPrefix() + 'campaigns:';
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function uiCacheClearAccount(accountId: string): void {
  if (typeof window === 'undefined' || !accountId) return;
  try {
    const prefix = PREFIX + accountId + ':';
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function uiCacheClearAll(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
