import { describe, expect, it } from 'vitest';
import { clearLicenseBind } from './license-bind.js';
import { readLicenseKey, writeLicenseKey } from './license-key-record.js';

describe('license key record', () => {
  it('keeps the key readable after bind is cleared', () => {
    const stored = writeLicenseKey(
      { adminNote: 'paid', boundIp: '203.0.113.40', boundAt: '2026-11-18T00:00:00.000Z' },
      'A94BDAAB11D094C5',
    );
    expect(readLicenseKey(stored)).toBe('A94BDAAB11D094C5');
    expect(String(stored.licenseKeyEnc)).not.toContain('A94BDAAB11D094C5');
    const cleared = clearLicenseBind(stored);
    expect(cleared.boundIp).toBeUndefined();
    expect(readLicenseKey(cleared)).toBe('A94BDAAB11D094C5');
    expect(cleared.adminNote).toBe('paid');
  });
});