/** Bind PC lives on this path. Public origin: https://novasreach.xyz/bind-pc */

export const BIND_PC_PATH = '/bind-pc';
export const PUBLIC_BIND_ORIGIN = 'https://novasreach.xyz';

export function isInboxflowDesktop() {
  return Boolean(typeof window !== 'undefined' && window.inboxflowDesktop?.isDesktop);
}

export function bindPcPath(username?: string) {
  const user = String(username || '').trim();
  return user ? `${BIND_PC_PATH}?user=${encodeURIComponent(user)}` : BIND_PC_PATH;
}

function configuredBindOrigin() {
  const configured = String(import.meta.env.VITE_BIND_PC_URL || '').trim();
  if (!configured) return '';
  try {
    const url = new URL(configured, PUBLIC_BIND_ORIGIN);
    return url.origin;
  } catch {
    return '';
  }
}

/** Relative path in this app, or an absolute Bind PC URL if VITE_BIND_PC_URL is set. */
export function bindPcHref(username?: string) {
  const configured = String(import.meta.env.VITE_BIND_PC_URL || '').trim();
  if (configured && /^https?:\/\//i.test(configured)) {
    const origin = configuredBindOrigin() || PUBLIC_BIND_ORIGIN;
    return `${origin}${bindPcPath(username)}`;
  }
  return bindPcPath(username);
}

/** Absolute URL admin copies for a created user. */
export function publicBindPcUrl(username?: string) {
  if (typeof window !== 'undefined' && window.location?.origin && !/^https?:\/\/localhost\b/i.test(window.location.origin)) {
    return `${window.location.origin}${bindPcPath(username)}`;
  }
  const origin = configuredBindOrigin() || PUBLIC_BIND_ORIGIN;
  return `${origin}${bindPcPath(username)}`;
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
