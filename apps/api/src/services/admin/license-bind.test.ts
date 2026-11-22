import { describe, expect, it } from 'vitest';
import {
  bindIpMustMatchRequest,
  licenseBindBlocked,
  licenseBindRequired,
  mergeLicenseBind,
  ipsMatch,
  parseTypedBindIp,
  publicClientIp,
  readLicenseBind,
} from './license-bind.js';

describe('license bind', () => {
  it('uses Fastify request.ip and ignores client x-forwarded-for', () => {
    expect(
      publicClientIp({
        ip: '203.0.113.40',
        headers: { 'x-forwarded-for': '1.2.3.4' },
      }),
    ).toBe('203.0.113.40');
  });

  it('strips ipv4-mapped ipv6', () => {
    expect(publicClientIp({ ip: '::ffff:198.51.100.7' })).toBe('198.51.100.7');
  });

  it('stores bind without dropping pulse', () => {
    const next = mergeLicenseBind(
      { operatorPulse: { emailsSent: 4 }, adminNote: 'paid' },
      { boundIp: '203.0.113.40', boundAt: '2026-11-18T00:00:00.000Z' },
    );
    expect(next.boundIp).toBe('203.0.113.40');
    expect(next.smtpAllowDirect).toBe(false);
    expect(next.workspaceLocal).toBe(true);
    expect(next.trackingOnDevice).toBe(true);
    expect(next.adminNote).toBe('paid');
    expect((next.operatorPulse as { emailsSent: number }).emailsSent).toBe(4);
    expect(readLicenseBind(next)?.boundIp).toBe('203.0.113.40');
  });

  it('blocks a second PC after bind', () => {
    expect(ipsMatch('203.0.113.40', '203.0.113.40')).toBe(true);
    const settings = { boundIp: '203.0.113.40', boundAt: '2026-11-18T00:00:00.000Z' };
    expect(licenseBindBlocked(settings, '203.0.113.40')).toBeNull();
    expect(licenseBindBlocked(settings, '198.51.100.9')).toMatch(/another PC/);
    expect(licenseBindBlocked({}, '198.51.100.9')).toBeNull();
  });

  it('requires bind before a created user can sign in', () => {
    expect(licenseBindRequired({})).toBe(true);
    expect(licenseBindRequired({ boundIp: '203.0.113.40' })).toBe(false);
  });

  it('accepts a typed RDP public IP and rejects loopback', () => {
    expect(parseTypedBindIp('203.0.113.40')).toBe('203.0.113.40');
    expect(parseTypedBindIp(' 105.127.10.134 ')).toBe('105.127.10.134');
    expect(parseTypedBindIp('127.0.0.1')).toBeNull();
    expect(parseTypedBindIp('not-an-ip')).toBeNull();
  });

  it('requires the typed bind IP to match the request IP', () => {
    expect(bindIpMustMatchRequest('203.0.113.40', '203.0.113.40')).toBeNull();
    expect(bindIpMustMatchRequest('203.0.113.40', '198.51.100.9')).toBe(
      'The IP you entered is not this PC’s public IP. Open Bind PC on the RDP/VPS you are activating.',
    );
    expect(bindIpMustMatchRequest('127.0.0.1', '203.0.113.40')).toBe(
      'Enter the public IP of this RDP / Windows VPS.',
    );
  });
});
