const API_URL = import.meta.env.VITE_API_URL || '';

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
};

class ApiClient {
  /** In-memory only — prefer httpOnly cookies; keep for Bearer fallback / smoke tools */
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    // Migrate away from legacy localStorage tokens (XSS risk)
    try {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
    } catch {
      /* ignore */
    }
  }

  setTokens(access: string | null, refresh?: string | null) {
    this.accessToken = access;
    if (refresh !== undefined) this.refreshToken = refresh;
  }

  getToken() {
    return this.accessToken;
  }

  clearSession() {
    this.accessToken = null;
    this.refreshToken = null;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    // Only set JSON content-type when there is a body — empty DELETE/GET bodies
    // with application/json make Fastify throw FST_ERR_CTP_EMPTY_JSON_BODY.
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    let res = await fetch(`${API_URL}${path}`, {
      method: options.method || 'GET',
      headers,
      credentials: 'include',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401) {
      const refreshed = await this.tryRefresh();
      if (refreshed) {
        if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
        else delete headers.Authorization;
        res = await fetch(`${API_URL}${path}`, {
          method: options.method || 'GET',
          headers,
          credentials: 'include',
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
      }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return data as T;
  }

  private async tryRefresh() {
    try {
      const body: Record<string, string> = {};
      if (this.refreshToken) body.refreshToken = this.refreshToken;
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.clearSession();
        return false;
      }
      const data = await res.json();
      // Keep memory copy for Authorization header if cookies are blocked
      this.setTokens(data.accessToken ?? null, data.refreshToken ?? null);
      return true;
    } catch {
      this.clearSession();
      return false;
    }
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
