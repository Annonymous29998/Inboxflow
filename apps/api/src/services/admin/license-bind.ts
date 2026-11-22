import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LicenseBind = {
  boundIp: string;
  boundAt: string;
};

export function normalizeClientIp(raw: string): string {
  let ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip.slice(0, 64);
}

/** Use Fastify `request.ip` only (trustProxy already applied). Do not read client headers. */
export function publicClientIp(input: { ip?: string; headers?: Record<string, unknown> }): string {
  return normalizeClientIp(String(input.ip || ''));
}

/** RDP/VPS public IP the user types on Bind PC. */
export function parseTypedBindIp(raw: string): string | null {
  const ip = normalizeClientIp(raw);
  if (!ip || ip === '127.0.0.1' || ip === '0.0.0.0' || ip === '::') return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const ok = v4.slice(1).every((p) => {
      const n = Number(p);
      return n >= 0 && n <= 255;
    });
    return ok ? ip : null;
  }
  if (ip.includes(':') && ip.length >= 3 && ip.length <= 64) return ip;
  return null;
}

export function boundIpFromSqliteSidecar(): string {
  const db = String(process.env.DATABASE_URL || '');
  if (!db.startsWith('file:')) return '';
  try {
    const file = db.replace(/^file:/, '').split('?')[0] || '';
    const side = join(dirname(file), 'bound-ip');
    if (!existsSync(side)) return '';
    return normalizeClientIp(String(readFileSync(side, 'utf8') || '').split(/\s+/)[0] || '');
  } catch {
    return '';
  }
}

export function deviceBoundIp(sendSettings?: unknown): string {
  return (
    readLicenseBind(sendSettings)?.boundIp ||
    normalizeClientIp(String(process.env.BOUND_IP || '')) ||
    boundIpFromSqliteSidecar()
  );
}

export function readLicenseBind(sendSettings: unknown): LicenseBind | null {
  const settings =
    sendSettings && typeof sendSettings === 'object' ? (sendSettings as Record<string, unknown>) : {};
  const ip = normalizeClientIp(String(settings.boundIp || ''));
  const at = String(settings.boundAt || '').slice(0, 40);
  if (!ip) return null;
  return { boundIp: ip, boundAt: at || new Date().toISOString() };
}

export function ipsMatch(a: string, b: string): boolean {
  return normalizeClientIp(a) === normalizeClientIp(b) && Boolean(normalizeClientIp(a));
}

/** Lightsail Bind PC: typed IP must be the TCP client IP (this VPS), not a claimed victim IP. */
export function bindIpMustMatchRequest(typedIp: string, requestIp: string): string | null {
  const want = parseTypedBindIp(typedIp);
  if (!want) return 'Enter the public IP of this RDP / Windows VPS.';
  const seen = normalizeClientIp(requestIp);
  if (!seen) return 'Could not see this PC’s public IP. Bind from the VPS, not through a VPN.';
  if (!ipsMatch(want, seen)) {
    return 'The IP you entered is not this PC’s public IP. Open Bind PC on the RDP/VPS you are activating.';
  }
  return null;
}

export function licenseBindBlocked(sendSettings: unknown, requestIp: string): string | null {
  const bind = readLicenseBind(sendSettings);
  if (!bind?.boundIp) return null;
  if (ipsMatch(bind.boundIp, requestIp)) return null;
  return 'This license is already activated on another PC. Ask admin to unbind it first.';
}

export const BIND_REQUIRED_MESSAGE =
  'Bind this PC first. Open Bind PC, enter your license key and IP address, then sign in.';

export function licenseBindRequired(sendSettings: unknown): boolean {
  return !readLicenseBind(sendSettings)?.boundIp;
}

export function clearLicenseBind(sendSettings: unknown): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  delete prev.boundIp;
  delete prev.boundAt;
  delete prev.trackingOnDevice;
  return prev;
}

/** Store the Windows VPS public IP. SMTP and tracking stay on that machine. */
export function operatorBindEnabled(sendSettings: unknown): boolean {
  const settings =
    sendSettings && typeof sendSettings === 'object' ? (sendSettings as Record<string, unknown>) : {};
  return settings.operatorBindEnabled === true && Boolean(readLicenseBind(settings)?.boundIp);
}

/** Operator optional Bind PC: send from this RDP/VPS instead of Lightsail. */
export function mergeOperatorBind(
  sendSettings: unknown,
  bind: { enabled: boolean; boundIp?: string; boundAt?: string },
): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  if (!bind.enabled) {
    prev.operatorBindEnabled = false;
    delete prev.boundIp;
    delete prev.boundAt;
    delete prev.trackingOnDevice;
    return prev;
  }
  prev.operatorBindEnabled = true;
  prev.boundIp = bind.boundIp;
  prev.boundAt = bind.boundAt || new Date().toISOString();
  prev.trackingOnDevice = true;
  return prev;
}

export function mergeLicenseBind(sendSettings: unknown, bind: LicenseBind): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  prev.boundIp = bind.boundIp;
  prev.boundAt = bind.boundAt;
  prev.workspaceLocal = true;
  prev.smtpAllowDirect = false;
  prev.trackingOnDevice = true;
  return prev;
}
