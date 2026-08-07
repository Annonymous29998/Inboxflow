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

  getTokens() {
    return { accessToken: this.accessToken, refreshToken: this.refreshToken };
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

  /**
   * Server-Sent Events stream (text/event-stream). Returns a controller to cancel.
   * Uses fetch+ReadableStream so Authorization: Bearer header works (EventSource API
   * does not support custom headers). Calls onEvent per SSE event, onDone when closed.
   */
  events(
    path: string,
    opts: {
      onEvent?: (event: string, data: any) => void;
      onError?: (error: Error) => void;
      onDone?: () => void;
    } = {},
  ): { cancel: () => void } {
    let cancelled = false;
    let controller: AbortController | null = null;
    const run = async () => {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
        controller = new AbortController();
        let res = await fetch(`${API_URL}${path}`, {
          method: 'GET',
          headers,
          credentials: 'include',
          signal: controller.signal,
        });
        if (res.status === 401) {
          const refreshed = await this.tryRefresh();
          if (refreshed) {
            if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
            else delete headers.Authorization;
            controller = new AbortController();
            res = await fetch(`${API_URL}${path}`, {
              method: 'GET',
              headers,
              credentials: 'include',
              signal: controller.signal,
            });
          }
        }
        if (!res.ok || !res.body) {
          let msg = `Stream failed (${res.status})`;
          try {
            const d = await res.json().catch(() => ({}));
            msg = d?.error || d?.message || msg;
          } catch {}
          throw new Error(msg);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let currentEvent = 'message';
        const emit = () => {
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? '';
          for (const chunk of parts) {
            if (cancelled) return;
            const lines = chunk.split(/\r?\n/);
            let dataStr = '';
            for (const line of lines) {
              if (line.startsWith(':')) continue;
              const idx = line.indexOf(':');
              const key = idx >= 0 ? line.slice(0, idx).trim() : '';
              const val = idx >= 0 ? line.slice(idx + 1).replace(/^ /, '') : '';
              if (key === 'event') currentEvent = val || 'message';
              else if (key === 'data') dataStr = dataStr ? `${dataStr}\n${val}` : val;
            }
            if (!dataStr.trim()) continue;
            try {
              const parsed = JSON.parse(dataStr);
              opts.onEvent?.(currentEvent, parsed);
            } catch {
              opts.onEvent?.(currentEvent, dataStr);
            }
            currentEvent = 'message';
          }
        };
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          emit();
        }
        if (buffer.trim()) emit();
        opts.onDone?.();
      } catch (e: any) {
        if (cancelled && (e?.name === 'AbortError' || String(e?.message || '').includes('abort'))) {
          opts.onDone?.();
          return;
        }
        opts.onError?.(e instanceof Error ? e : new Error(String(e || 'Stream error')));
      }
    };
    run();
    return {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        try { controller?.abort(); } catch {}
      },
    };
  }

  async blob(path: string, options: RequestOptions = {}): Promise<Blob> {
    const headers: Record<string, string> = {};
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

    if (!res.ok) {
      let data: any = {};
      try { data = await res.json().catch(() => ({})); } catch {}
      throw new Error(data.error || data.message || `Request failed (${res.status})`);
    }
    return await res.blob();
  }
}

export const api = new ApiClient();
