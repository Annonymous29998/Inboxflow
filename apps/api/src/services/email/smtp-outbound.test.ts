import { describe, expect, it } from 'vitest';
import {
  assertOutboundPathAllowed,
  isBindableIp,
  normalizeSmtpOutboundPath,
  orgAllowsDirectSmtp,
  smtpBindLocalAddress,
  smtpSocksProxyUrl,
} from './smtp-outbound.js';

describe('smtp outbound path', () => {
  it('defaults to direct', () => {
    expect(normalizeSmtpOutboundPath(undefined)).toBe('direct');
    expect(normalizeSmtpOutboundPath(' Direct ')).toBe('direct');
  });

  it('accepts bind and socks', () => {
    expect(normalizeSmtpOutboundPath('bind')).toBe('bind');
    expect(normalizeSmtpOutboundPath('remote')).toBe('bind');
    expect(normalizeSmtpOutboundPath('SOCKS')).toBe('socks');
  });

  it('bind requires a local IP', () => {
    expect(() => smtpBindLocalAddress({ outboundPath: 'bind' })).toThrow(/Bind IP is required/);
    expect(smtpBindLocalAddress({ outboundPath: 'direct', bindIp: '203.0.113.10' })).toBeUndefined();
    expect(smtpBindLocalAddress({ outboundPath: 'bind', bindIp: '203.0.113.10' })).toBe('203.0.113.10');
  });

  it('rejects junk bind IPs', () => {
    expect(isBindableIp('999.1.1.1')).toBe(false);
    expect(() => smtpBindLocalAddress({ outboundPath: 'bind', bindIp: 'not-an-ip' })).toThrow(/IPv4/);
  });

  it('lets platform admin use Direct; tenant orgs must bind or SOCKS', () => {
    expect(orgAllowsDirectSmtp({ role: 'SUPER_ADMIN', email: 'anyone@x.com' })).toBe(true);
    expect(orgAllowsDirectSmtp({ email: 'admin@inboxflow.com' })).toBe(true);
    expect(
      orgAllowsDirectSmtp({
        role: 'USER',
        email: 'new@user.com',
        sendSettings: { smtpAllowDirect: false },
      }),
    ).toBe(false);
    expect(orgAllowsDirectSmtp({ role: 'USER', email: 'legacy@user.com' })).toBe(true);
    expect(() =>
      assertOutboundPathAllowed({ outboundPath: 'direct' }, false),
    ).toThrow(/Bind IP or SOCKS5/);
    expect(() => assertOutboundPathAllowed({ outboundPath: 'bind', bindIp: '1.1.1.1' }, false)).not.toThrow();
  });

  it('builds a socks5 URL', () => {
    expect(
      smtpSocksProxyUrl({
        outboundPath: 'socks',
        socksHost: '10.0.0.8',
        socksPort: '1080',
        socksUser: 'proxy',
        socksPass: 's3cret',
      }),
    ).toBe('socks5://proxy:s3cret@10.0.0.8:1080');
    expect(smtpSocksProxyUrl({ outboundPath: 'direct', socksHost: '10.0.0.8' })).toBeUndefined();
  });
});
