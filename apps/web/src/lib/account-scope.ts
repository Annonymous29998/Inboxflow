/** Per-login namespace so tenant mailer, admin mailer, and admin UI do not share snapshots. */

export function currentAccountId(): string {
  if (typeof window === 'undefined') return 'anon';
  try {
    const raw = window.sessionStorage.getItem('inboxflow-auth');
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { user?: { id?: string } } };
      const id = parsed?.state?.user?.id;
      if (id) return id;
    }
    const fb = window.localStorage.getItem('inboxflow-auth-fallback');
    if (fb) {
      const parsed = JSON.parse(fb) as { user?: { id?: string } };
      const id = parsed?.user?.id;
      if (id) return id;
    }
  } catch {
    /* ignore */
  }
  return 'anon';
}

export function accountScopedKey(base: string): string {
  return `${base}:${currentAccountId()}`;
}
