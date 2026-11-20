export type DesktopLicenseConfig = {
  username?: string;
  license_key?: string;
};

function pick(raw: Record<string, unknown>): DesktopLicenseConfig {
  const username = String(raw.username || raw.user || '').trim();
  const license_key = String(raw.license_key || raw.licenseKey || raw.license || '').trim();
  return {
    ...(username ? { username } : {}),
    ...(license_key ? { license_key } : {}),
  };
}

/** Local EXE only: `http://localhost:5000/config.json` is served from this PC, not Lightsail. */
export async function loadDesktopLicenseConfig(): Promise<DesktopLicenseConfig | null> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    const next = pick(data);
    if (!next.username && !next.license_key) return null;
    return next;
  } catch {
    return null;
  }
}

export function licenseConfigJson(username: string, licenseKey: string) {
  return `${JSON.stringify({ username, license_key: licenseKey }, null, 4)}\n`;
}
