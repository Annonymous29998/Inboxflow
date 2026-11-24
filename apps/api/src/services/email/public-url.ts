import { isIP } from 'node:net';
import { deviceBoundIp } from '../admin/license-bind.js';
import { usesInProcessSend } from '../../config/db-kind.js';

/** Base URL Gmail/Outlook can hit for open pixels, clicks, unsubscribe. */
export function resolvePublicBaseUrl(input: {
  publicUrl?: string;
  trackingBaseUrl?: string;
  apiUrl?: string;
}): string {
  const pick = [input.publicUrl, input.trackingBaseUrl, input.apiUrl]
    .map((v) => String(v || '').trim().replace(/\/$/, ''))
    .find((v) => /^https?:\/\//i.test(v));
  return pick || 'http://localhost:3001';
}

/**
 * Office 365, Gmail, and Yahoo fetch the unsubscribe link before they accept bulk mail.
 * They expect https on port 443 and a hostname, not a raw IP or an extra port.
 */
export function isMailboxProviderTrackingOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.port && u.port !== '443') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host || isIP(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function isLoopbackPublicUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return true;
  }
}

export function isSharedCloudTrackingUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === '13.38.60.67') return true;
    const remote = String(process.env.REMOTE_APP_URL || '').trim();
    if (remote) {
      const rh = new URL(remote).hostname.toLowerCase();
      if (rh && rh === host) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function publishedPort(): number {
  const n = Number(process.env.TRACKING_PORT || process.env.LOCAL_PORT || 5000);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

/** Public site on port 443. Mailbox providers fetch this. No :5000. */
export function cloudTrackingOrigin(): string {
  const candidates = [process.env.REMOTE_APP_URL, process.env.PUBLIC_URL, 'https://novasreach.xyz'];
  for (const raw of candidates) {
    const url = String(raw || '').trim().replace(/\/$/, '');
    if (isMailboxProviderTrackingOrigin(url)) return url;
  }
  return 'https://novasreach.xyz';
}

/** Hostname recipients' CNAME must point at. This is the site we control. */
export function trackingCnameTarget(): string {
  try {
    return new URL(cloudTrackingOrigin()).hostname.toLowerCase();
  } catch {
    return 'novasreach.xyz';
  }
}

/** https://track.example.com when the tracking CNAME is verified. No port. */
export function httpsTrackingOrigin(input?: {
  trackingDomain?: string | null;
  trackingValid?: boolean;
} | null): string | null {
  if (!input?.trackingValid) return null;
  const host = String(input.trackingDomain || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host || host.includes('/') || host.includes(':') || !host.includes('.')) return null;
  if (isIP(host)) return null;
  return `https://${host}`;
}

/**
 * A verified tracking domain wins for every workspace, including mail sent from a PC.
 * Until that HTTPS name is ready, PC mail stays on the public site.
 */
export function resolveTrackingOrigin(input: {
  sendSettings?: unknown;
  trackingDomain?: string | null;
  trackingValid?: boolean;
  workspaceOnDevice?: boolean;
}): string {
  const https = httpsTrackingOrigin(input);
  if (https) return https;
  if (input.workspaceOnDevice) return cloudTrackingOrigin();
  return resolveDeviceTrackingOrigin(input.sendSettings);
}

/** Keep https://track.customer.com when minting still returns the shared site. */
export function preferVerifiedTrackingOrigin(localOrigin: string, fallback: string): string {
  try {
    const url = new URL(localOrigin);
    const cloudHost = new URL(cloudTrackingOrigin()).hostname;
    if (url.protocol === 'https:' && !url.port && !isIP(url.hostname) && url.hostname !== cloudHost) {
      return localOrigin;
    }
  } catch {
    /* the fallback is the public site */
  }
  return fallback;
}

/** Bound PC address. Used only when the workspace is not on the public tracking site. */
export function resolveDeviceTrackingOrigin(sendSettings?: unknown): string {
  const bound = deviceBoundIp(sendSettings);
  if (bound && bound !== '127.0.0.1') {
    return `http://${bound}:${publishedPort()}`;
  }
  const fallback = resolvePublicBaseUrl({
    publicUrl: process.env.PUBLIC_URL,
    trackingBaseUrl: process.env.TRACKING_BASE_URL,
    apiUrl: process.env.API_URL,
  });
  if (usesInProcessSend() && isSharedCloudTrackingUrl(fallback)) {
    return resolvePublicBaseUrl({ apiUrl: process.env.API_URL });
  }
  return fallback;
}
