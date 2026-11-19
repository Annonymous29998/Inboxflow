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

/** Created-user EXE: Gmail hits this VPS, never Lightsail. */
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
