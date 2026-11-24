import { describe, expect, it } from 'vitest';
import { classifySmtpRecipientResult, smtpRecipientStatus } from './smtp-recipient-result.js';
import {
  httpsTrackingOrigin,
  isLoopbackPublicUrl,
  isSharedCloudTrackingUrl,
  resolveDeviceTrackingOrigin,
  resolvePublicBaseUrl,
  preferVerifiedTrackingOrigin,
  resolveTrackingOrigin,
} from './public-url.js';

describe('smtp recipient result', () => {
  it('marks mailbox full as a soft bounce', () => {
    expect(classifySmtpRecipientResult('452 4.2.2 Mailbox full')).toBe('soft_bounce');
    expect(smtpRecipientStatus('soft_bounce')).toBe('BOUNCED');
  });

  it('marks unknown mailbox as a hard bounce', () => {
    expect(classifySmtpRecipientResult('550 5.1.1 User unknown')).toBe('hard_bounce');
  });

  it('marks content/auth rejects as failed, not bounce', () => {
    expect(classifySmtpRecipientResult('554 5.7.1 Message rejected as spam')).toBe('failed');
    expect(classifySmtpRecipientResult('535 5.7.8 Authentication failed')).toBe('failed');
  });
});

describe('public tracking URL', () => {
  it('prefers PUBLIC_URL over localhost API_URL', () => {
    expect(
      resolvePublicBaseUrl({
        publicUrl: 'http://203.0.113.40:5000',
        apiUrl: 'http://localhost:5000',
      }),
    ).toBe('http://203.0.113.40:5000');
  });

  it('flags loopback so opens cannot work from Gmail', () => {
    expect(isLoopbackPublicUrl('http://localhost:5000')).toBe(true);
    expect(isLoopbackPublicUrl('http://203.0.113.40:5000')).toBe(false);
  });

  it('treats Lightsail as shared cloud tracking', () => {
    expect(isSharedCloudTrackingUrl('http://13.38.60.67')).toBe(true);
    expect(isSharedCloudTrackingUrl('http://203.0.113.40:5000')).toBe(false);
  });

  it('uses the verified tracking domain on https without a port', () => {
    expect(httpsTrackingOrigin({ trackingDomain: 'track.example.com', trackingValid: true })).toBe(
      'https://track.example.com',
    );
    expect(httpsTrackingOrigin({ trackingDomain: 'track.example.com', trackingValid: false })).toBeNull();
    expect(
      resolveTrackingOrigin({
        trackingDomain: 'track.example.com',
        trackingValid: true,
        workspaceOnDevice: false,
        sendSettings: { boundIp: '203.0.113.40' },
      }),
    ).toBe('https://track.example.com');
  });

  it('uses one verified tracking domain for PC mail, and the public site until then', () => {
    const prev = process.env.REMOTE_APP_URL;
    process.env.REMOTE_APP_URL = 'https://novasreach.xyz';
    expect(
      resolveTrackingOrigin({
        trackingDomain: 'track.example.com',
        trackingValid: true,
        workspaceOnDevice: true,
      }),
    ).toBe('https://track.example.com');
    expect(
      resolveTrackingOrigin({
        workspaceOnDevice: true,
      }),
    ).toBe('https://novasreach.xyz');
    expect(
      preferVerifiedTrackingOrigin('https://track.example.com', 'https://novasreach.xyz'),
    ).toBe('https://track.example.com');
    expect(
      preferVerifiedTrackingOrigin('https://novasreach.xyz', 'https://novasreach.xyz'),
    ).toBe('https://novasreach.xyz');
    process.env.REMOTE_APP_URL = prev;
  });

  it('builds open/click origin from the VPS bound IP', () => {
    const prevIp = process.env.BOUND_IP;
    const prevPort = process.env.TRACKING_PORT;
    process.env.BOUND_IP = '203.0.113.40';
    process.env.TRACKING_PORT = '5000';
    expect(resolveDeviceTrackingOrigin()).toBe('http://203.0.113.40:5000');
    process.env.BOUND_IP = prevIp;
    process.env.TRACKING_PORT = prevPort;
  });
});
