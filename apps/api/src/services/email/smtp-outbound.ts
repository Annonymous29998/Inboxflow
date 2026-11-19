export type SmtpOutboundPath = 'direct' | 'bind' | 'socks';

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

export function normalizeSmtpOutboundPath(raw: unknown): SmtpOutboundPath {
  const p = String(raw || 'direct').trim().toLowerCase();
  if (p === 'bind' || p === 'remote') return 'bind';
  if (p === 'socks') return 'socks';
  return 'direct';
}

const PLATFORM_ADMIN_EMAIL = String(process.env.PLATFORM_ADMIN_EMAIL || 'admin@inboxflow.com')
  .toLowerCase()
  .trim();

/** Direct (shared Lightsail NIC) is only for the platform admin workspace. */
export function orgAllowsDirectSmtp(input: {
  sendSettings?: unknown;
  role?: string | null;
  email?: string | null;
}): boolean {
  const email = String(input.email || '').toLowerCase().trim();
  const role = String(input.role || '');
  if (role === 'SUPER_ADMIN' || (PLATFORM_ADMIN_EMAIL && email === PLATFORM_ADMIN_EMAIL)) {
    return true;
  }
  const settings =
    input.sendSettings && typeof input.sendSettings === 'object'
      ? (input.sendSettings as Record<string, unknown>)
      : {};
  if (settings.smtpAllowDirect === false) return false;
  return true;
}

export function assertOutboundPathAllowed(
  config: Record<string, string>,
  allowDirect: boolean,
): void {
  if (allowDirect) return;
  if (normalizeSmtpOutboundPath(config.outboundPath) === 'direct') {
    throw new Error(
      'Set Bind IP or SOCKS5 on the SMTP profile.',
    );
  }
}

export function isBindableIp(value: string): boolean {
  const ip = String(value || '').trim();
  if (IPV4.test(ip)) {
    return ip.split('.').every((o) => {
      const n = Number(o);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  if (ip.includes(':') && IPV6.test(ip) && ip.length >= 3) return true;
  return false;
}

export function smtpBindLocalAddress(config: Record<string, string>): string | undefined {
  const raw = String(config.outboundPath || '').trim().toLowerCase();
  if (raw === 'ssh') {
    throw new Error('SSH tunnel is stored on the profile — live send hops with SOCKS5, Bind IP, or Direct.');
  }
  if (normalizeSmtpOutboundPath(config.outboundPath) !== 'bind') return undefined;
  const ip = String((raw === 'remote' ? config.remoteIp : config.bindIp) || config.bindIp || config.remoteIp || '').trim();
  if (!ip) {
    throw new Error(
      raw === 'remote'
        ? 'Remote host IP is required.'
        : 'Bind IP is required. Use an address this machine already has.',
    );
  }
  if (!isBindableIp(ip)) {
    throw new Error('Bind IP must be an IPv4 or IPv6 address on this send machine.');
  }
  return ip;
}

export function smtpSocksProxyUrl(config: Record<string, string>): string | undefined {
  if (normalizeSmtpOutboundPath(config.outboundPath) !== 'socks') return undefined;
  const host = String(config.socksHost || '').trim();
  const port = Number(config.socksPort || 1080);
  if (!host) {
    throw new Error('SOCKS host is required for the SOCKS path.');
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('SOCKS port must be 1–65535.');
  }
  const user = String(config.socksUser || '').trim();
  const pass = String(config.socksPass || '');
  const auth = user
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : '';
  return `socks5://${auth}${host}:${port}`;
}
