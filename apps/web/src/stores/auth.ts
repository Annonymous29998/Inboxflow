import { create } from 'zustand';
import { api } from '../lib/api';

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
};

type AuthState = {
  user: User | null;
  loading: boolean;
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
  fetchMe: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  setUser: (user) => set({ user }),
  login: async (email, password, totpCode) => {
    const data = await api.post<{
      requires2FA?: boolean;
      accessToken?: string;
      refreshToken?: string;
      user?: User;
    }>('/api/auth/login', { email, password, totpCode });
    if (data.requires2FA) return { requires2FA: true };
    // Cookies are primary; keep tokens in memory as Bearer fallback
    api.setTokens(data.accessToken ?? null, data.refreshToken ?? null);
    set({ user: data.user! });
    return {};
  },
  register: async (payload) => {
    const data = await api.post<{ accessToken: string; refreshToken: string; user: User }>(
      '/api/auth/register',
      payload,
    );
    api.setTokens(data.accessToken, data.refreshToken);
    set({ user: data.user });
  },
  logout: async () => {
    try {
      await api.post('/api/auth/logout', {});
    } catch {
      /* ignore */
    }
    api.clearSession();
    set({ user: null });
  },
  fetchMe: async () => {
    try {
      const data = await api.get<{ user: User }>('/api/auth/me');
      set({ user: data.user, loading: false });
    } catch {
      api.clearSession();
      set({ user: null, loading: false });
    }
  },
}));
