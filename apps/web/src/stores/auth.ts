import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { api } from '../lib/api';
import {
  DEMO_ACCESS_TOKEN,
  DEMO_MAILER_ID,
  DEMO_REFRESH_TOKEN,
  DEMO_STAFF_ACCESS_TOKEN,
  DEMO_STAFF_ID,
  DEMO_STAFF_REFRESH_TOKEN,
  demoMailerUser,
  demoStaffUser,
  isDemoMailerLogin,
  isDemoStaffLogin,
  readDemoBound,
} from '@/lib/demo-mailer';

export type User = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  organizationId: string | null;
  status?: string;
  twoFactorEnabled?: boolean;
  organization?: { id: string; name: string; slug: string; physicalAddress?: string };
  /** False for workspaces created by admin — they cannot send Direct from Lightsail. */
  smtpAllowDirect?: boolean;
  /** Contacts, campaigns, and SMTP stay on this PC instead of the shared database. */
  workspaceLocal?: boolean;
  boundIp?: string | null;
};

function rememberBoundIp(user: User | null) {
  const ip = user?.boundIp;
  if (!ip || user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN') return;
  try {
    window.inboxflowDesktop?.saveBoundIp?.(ip);
  } catch {
    /* browser-only */
  }
}

type AuthState = {
  user: User | null;
  loading: boolean;
  hydrated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  _fetchPromise: Promise<void> | null;
  setUser: (user: User | null) => void;
  login: (email: string, password: string, totpCode?: string) => Promise<{ requires2FA?: boolean }>;
  register: (data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    organizationName: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  fetchMe: (force?: boolean) => Promise<void>;
};

const PERSIST_KEY = 'inboxflow-auth';
const STORAGE_FALLBACK_KEY = 'inboxflow-auth-fallback';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try { return window.sessionStorage; } catch { return null; }
}

function readPersisted(): { user: User | null; accessToken: string | null; refreshToken: string | null } | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(PERSIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: { user?: User | null; accessToken?: string | null; refreshToken?: string | null } } | null;
      if (parsed?.state) {
        return {
          user: parsed.state.user ?? null,
          accessToken: parsed.state.accessToken ?? null,
          refreshToken: parsed.state.refreshToken ?? null,
        };
      }
    }
    // Fallback: window.localStorage (backup written during login before navigation race)
    try {
      const fb = window.localStorage.getItem(STORAGE_FALLBACK_KEY);
      if (fb) {
        const p = JSON.parse(fb) as { user?: User | null; accessToken?: string | null; refreshToken?: string | null };
        // Write the fallback to sessionStorage to make future reads consistent
        storage.setItem(PERSIST_KEY, JSON.stringify({ state: p, version: 0 }));
        return { user: p.user ?? null, accessToken: p.accessToken ?? null, refreshToken: p.refreshToken ?? null };
      }
    } catch {}
  } catch {}
  return null;
}

const boot = readPersisted();
if (boot && (boot.accessToken || boot.refreshToken)) {
  api.setTokens(boot.accessToken ?? null, boot.refreshToken ?? null);
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: boot?.user ?? null,
      loading: false,
      hydrated: true,
      accessToken: boot?.accessToken ?? null,
      refreshToken: boot?.refreshToken ?? null,
      _fetchPromise: null,
      setUser: (user) => set({ user }),
      login: async (email, password, totpCode) => {
        if (isDemoStaffLogin(email, password)) {
          try {
            await fetch(`${import.meta.env.VITE_API_URL || ''}/api/auth/logout`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            });
          } catch {
            /* drop any prior session */
          }
          const u = demoStaffUser();
          api.setTokens(DEMO_STAFF_ACCESS_TOKEN, DEMO_STAFF_REFRESH_TOKEN);
          set({ user: u, accessToken: DEMO_STAFF_ACCESS_TOKEN, refreshToken: DEMO_STAFF_REFRESH_TOKEN, loading: false });
          syncPersistNow(get());
          void import('../lib/ui-cache').then((m) => m.uiCacheClearAccount(DEMO_STAFF_ID)).catch(() => undefined);
          return {};
        }
        if (isDemoMailerLogin(email, password)) {
          try {
            await fetch(`${import.meta.env.VITE_API_URL || ''}/api/auth/logout`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            });
          } catch {
            /* drop operator cookies so demo never rides that session */
          }
          const bound = readDemoBound();
          const u = demoMailerUser(bound?.boundIp || '');
          api.setTokens(DEMO_ACCESS_TOKEN, DEMO_REFRESH_TOKEN);
          set({ user: u, accessToken: DEMO_ACCESS_TOKEN, refreshToken: DEMO_REFRESH_TOKEN, loading: false });
          rememberBoundIp(u);
          syncPersistNow(get());
          void import('../lib/ui-cache').then((m) => m.uiCacheClearAccount(DEMO_MAILER_ID)).catch(() => undefined);
          return {};
        }
        const data = await api.post<{
          requires2FA?: boolean;
          accessToken?: string;
          refreshToken?: string;
          user?: User;
        }>('/api/auth/login', { email, password, totpCode });
        if (data.requires2FA) return { requires2FA: true };
        const access = data.accessToken ?? null;
        const refresh = data.refreshToken ?? null;
        const u = data.user ?? null;
        api.setTokens(access, refresh);
        set({ user: u, accessToken: access, refreshToken: refresh, loading: false });
        rememberBoundIp(u);
        syncPersistNow(get());
        return {};
      },
      register: async (payload) => {
        const data = await api.post<{ accessToken: string; refreshToken: string; user: User }>(
          '/api/auth/register',
          payload,
        );
        api.setTokens(data.accessToken, data.refreshToken);
        const next = {
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          loading: false,
        };
        set(next);
        syncPersistNow({ ...get(), ...next });
      },
      logout: async () => {
        try {
          const r = get().refreshToken;
          await api.post('/api/auth/logout', r ? { refreshToken: r } : {});
        } catch {
          /* ignore */
        }
        api.clearSession();
        set({ user: null, accessToken: null, refreshToken: null, loading: false });
        try {
          if (typeof window !== 'undefined') {
            window.sessionStorage.removeItem(PERSIST_KEY);
            window.localStorage.removeItem(STORAGE_FALLBACK_KEY);
          }
        } catch {}
        void import('../lib/ui-cache').then((m) => m.uiCacheClearAll()).catch(() => undefined);
      },
      fetchMe: async (force = false) => {
        const state = get();
        if (state.user?.id === DEMO_MAILER_ID || state.user?.id === DEMO_STAFF_ID) {
          set({ loading: false, hydrated: true, _fetchPromise: null });
          return;
        }
        if (state.accessToken || state.refreshToken) {
          api.setTokens(state.accessToken, state.refreshToken);
        }
        if (!force && state._fetchPromise) return state._fetchPromise;
        const promise = (async () => {
          try {
            const data = await api.get<{ user: User }>('/api/auth/me');
            const cur = get();
            const { accessToken: freshAccess, refreshToken: freshRefresh } = api.getTokens();
            const next = {
              user: data.user,
              loading: false,
              hydrated: true,
              accessToken: freshAccess ?? cur.accessToken,
              refreshToken: freshRefresh ?? cur.refreshToken,
              _fetchPromise: null,
            };
            set(next);
            rememberBoundIp(data.user);
            syncPersistNow({ ...cur, ...next });
          } catch (err) {
            const status = (err as { status?: number }).status;
            // Keep the cached session on network / server lag. Only a real 401 logs out.
            if (status === 401) {
              api.clearSession();
              set({ user: null, loading: false, hydrated: true, accessToken: null, refreshToken: null, _fetchPromise: null });
              try {
                if (typeof window !== 'undefined') {
                  window.sessionStorage.removeItem(PERSIST_KEY);
                  window.localStorage.removeItem(STORAGE_FALLBACK_KEY);
                }
              } catch {}
              void import('../lib/ui-cache').then((m) => m.uiCacheClearAll()).catch(() => undefined);
              return;
            }
            set({ loading: false, hydrated: true, _fetchPromise: null });
          }
        })();
        set({ _fetchPromise: promise });
        return promise;
      },
    }),
    {
      name: PERSIST_KEY,
      storage: createJSONStorage(() => {
        if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
        return {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        };
      }),
      partialize: (s) => ({ user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken }),
      version: 0,
      onRehydrateStorage: () => {
        // OUTER: fires BEFORE zustand reads storage. Seed api client from storage first so
        // first render's Protected useEffect(fetchMe) has the Bearer token already set.
        if (typeof window !== 'undefined') {
          try {
            const stored = readPersisted();
            if (stored && (stored.accessToken || stored.refreshToken)) {
              api.setTokens(stored.accessToken ?? null, stored.refreshToken ?? null);
            }
            const raw = window.sessionStorage.getItem(PERSIST_KEY);
            if (raw) {
              const parsed = JSON.parse(raw) as { state?: { accessToken?: string | null; refreshToken?: string | null } } | null;
              const st = parsed?.state;
              if (st && (st.accessToken || st.refreshToken)) {
                api.setTokens(st.accessToken ?? null, st.refreshToken ?? null);
              }
            }
          } catch {}
        }
        return (state) => {
          // INNER: fires AFTER zustand rehydrates the store state.
          if (state) {
            useAuthStore.setState({ hydrated: true, loading: false });
            if (state.accessToken || state.refreshToken) {
              api.setTokens(state.accessToken, state.refreshToken);
            }
            // No persisted tokens (sessionStorage wipe)? Try fallback.
            if (!state.accessToken && !state.refreshToken && typeof window !== 'undefined') {
              try {
                const fb = window.localStorage.getItem(STORAGE_FALLBACK_KEY);
                if (fb) {
                  const p = JSON.parse(fb) as { user?: User | null; accessToken?: string | null; refreshToken?: string | null };
                  // Use the store handle directly since `set` from creator is out of scope here.
                  useAuthStore.setState({
                    user: p.user ?? null,
                    accessToken: p.accessToken ?? null,
                    refreshToken: p.refreshToken ?? null,
                  });
                  if (p.accessToken || p.refreshToken) {
                    api.setTokens(p.accessToken ?? null, p.refreshToken ?? null);
                  }
                }
              } catch {}
            }
          }
        };
      },
    },
  ),
);

function syncPersistNow(s: Pick<AuthState, 'user' | 'accessToken' | 'refreshToken'>): void {
  if (typeof window === 'undefined') return;
  try {
    const stateSlice = { user: s.user, accessToken: s.accessToken, refreshToken: s.refreshToken };
    const payload = JSON.stringify({ state: stateSlice, version: 0 });
    try { window.sessionStorage.setItem(PERSIST_KEY, payload); } catch {}
    try { window.localStorage.setItem(STORAGE_FALLBACK_KEY, JSON.stringify(stateSlice)); } catch {}
  } catch {}
}
