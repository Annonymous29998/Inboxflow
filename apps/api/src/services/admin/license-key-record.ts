import { decrypt, encrypt } from '../../utils/crypto.js';

const FIELD = 'licenseKeyEnc';

export function writeLicenseKey(sendSettings: unknown, plain: string): Record<string, unknown> {
  const prev =
    sendSettings && typeof sendSettings === 'object' ? { ...(sendSettings as Record<string, unknown>) } : {};
  const key = plain.trim();
  if (!key) return prev;
  prev[FIELD] = encrypt(key);
  return prev;
}

export function readLicenseKey(sendSettings: unknown): string {
  const settings =
    sendSettings && typeof sendSettings === 'object' ? (sendSettings as Record<string, unknown>) : {};
  const raw = String(settings[FIELD] || '');
  if (!raw) return '';
  try {
    return decrypt(raw);
  } catch {
    return '';
  }
}
