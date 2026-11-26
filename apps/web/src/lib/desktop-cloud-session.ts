import { api } from '@/lib/api';
import { isInboxflowDesktop } from '@/lib/bind-pc';
import { useAuthStore } from '@/stores/auth';

function expiry(token: string | null | undefined): number {
  const part = String(token || '').split('.')[1];
  if (!part) return 0;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Give the send process the sign-in, so a dark screen can still refresh it. */
export async function publishDesktopCloudSession() {
  if (!isInboxflowDesktop()) return;
  const { user, accessToken, refreshToken } = useAuthStore.getState();
  if (!user?.organizationId || !accessToken) return;
  await fetch('/api/desktop/cloud-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organizationId: user.organizationId,
      accessToken,
      refreshToken: refreshToken || undefined,
    }),
  }).catch(() => undefined);
}

/** Take a newer sign-in back from the send process after the screen wakes. */
export async function pullDesktopCloudSession() {
  if (!isInboxflowDesktop()) return;
  const res = await fetch('/api/desktop/cloud-session').catch(() => null);
  if (!res?.ok) return;
  const data = (await res.json().catch(() => null)) as {
    session?: { accessToken?: string; refreshToken?: string } | null;
  } | null;
  const session = data?.session;
  if (!session?.accessToken) return;
  const current = api.getTokens();
  if (expiry(session.accessToken) <= expiry(current.accessToken)) return;
  api.setTokens(session.accessToken, session.refreshToken || current.refreshToken);
}
