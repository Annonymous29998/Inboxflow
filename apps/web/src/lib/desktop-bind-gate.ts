import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { isInboxflowDesktop } from '@/lib/bind-pc';
import { tenantNeedsBind } from '@/lib/roles';
import { useAuthStore, type User } from '@/stores/auth';

export type DesktopBindVerdict = 'bound' | 'unbound' | 'unknown';

let inflight: Promise<DesktopBindVerdict> | null = null;
let closeOnce = false;

/**
 * Ask the account server before the EXE closes.
 * unbound = the server says this account has no PC.
 * unknown = the check failed. Do not close the app.
 */
export function refreshDesktopBind(): Promise<DesktopBindVerdict> {
  if (!isInboxflowDesktop()) return Promise.resolve('bound');
  const current = useAuthStore.getState().user;
  if (!current || !tenantNeedsBind(current)) return Promise.resolve('bound');
  if (!inflight) {
    inflight = (async () => {
      try {
        const data = await api.get<{ user?: User }>('/api/auth/me');
        const fresh = data.user;
        if (fresh) useAuthStore.getState().setUser({ ...useAuthStore.getState().user!, ...fresh });
        const verdict: DesktopBindVerdict = tenantNeedsBind(useAuthStore.getState().user) ? 'unbound' : 'bound';
        if (verdict === 'unbound' && !closeOnce) {
          closeOnce = true;
          window.inboxflowDesktop?.bindBlocked?.();
        }
        return verdict;
      } catch {
        return 'unknown';
      }
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function useDesktopBindGate(user: { id?: string; role?: string | null; boundIp?: string | null } | null | undefined) {
  const [verdict, setVerdict] = useState<DesktopBindVerdict | null>(null);
  useEffect(() => {
    if (!isInboxflowDesktop() || !user || !tenantNeedsBind(user)) {
      setVerdict(null);
      return;
    }
    let cancel = false;
    void refreshDesktopBind().then((next) => {
      if (!cancel) setVerdict(next);
    });
    return () => {
      cancel = true;
    };
  }, [user?.id, user?.boundIp, user?.role]);
  return verdict;
}
