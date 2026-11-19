/** Bind PC lives on this path. Set VITE_BIND_PC_URL later to a public origin (e.g. https://inboxflow.io/bind-pc). */
export const BIND_PC_PATH = '/bind-pc';

export function bindPcHref(): string {
  const configured = String(import.meta.env.VITE_BIND_PC_URL || '').trim();
  return configured || BIND_PC_PATH;
}

export function bindPcIsExternal(href: string) {
  if (!/^https?:\/\//i.test(href)) return false;
  if (typeof window === 'undefined') return true;
  try {
    return new URL(href, window.location.origin).origin !== window.location.origin;
  } catch {
    return true;
  }
}
