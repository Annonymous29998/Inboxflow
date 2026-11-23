import { isInboxflowDesktop } from '@/lib/bind-pc';
import { tenantNeedsBind } from '@/lib/roles';
import { useAuthStore } from '@/stores/auth';

let inflight: Promise<boolean> | null = null;

/**
 * EXE sessions saved before Bind PC have no bound IP.
 * Ask the server once before closing. True means the account is still unbound.
 */
export function desktopStillUnbound(): Promise<boolean> {
  if (!isInboxflowDesktop()) return Promise.resolve(false);
  const current = useAuthStore.getState().user;
  if (!current || !tenantNeedsBind(current)) return Promise.resolve(false);
  if (!inflight) {
    inflight = useAuthStore
      .getState()
      .fetchMe(true)
      .then(() => tenantNeedsBind(useAuthStore.getState().user))
      .catch(() => tenantNeedsBind(useAuthStore.getState().user))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
