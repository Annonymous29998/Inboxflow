import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { recommendedSpfForHosts } from '../deliverability/smtp-auth-hints.js';
import { judgeIssuedRecord } from './domain-dns.js';

function issuedRecords(smtpHost: string) {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const publicB64 = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const spf = recommendedSpfForHosts([smtpHost]);
  return {
    mechanisms: spf.hints.flatMap((hint) => hint.spfMechanisms),
    spf: spf.record,
    dkim: `v=DKIM1; k=rsa; p=${publicB64}`,
    dmarc: 'v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100',
    tracking: 'track.inboxflow.io',
    bounce: 'bounce.inboxflow.io',
    token: 'verify-token-example',
  };
}

describe('records Inbox Flow gives the user', () => {
  const issued = issuedRecords('email-smtp.eu-west-1.amazonaws.com');

  it('are real SPF, DKIM, and DMARC values', () => {
    expect(issued.spf.startsWith('v=spf1 ')).toBe(true);
    expect(issued.spf.endsWith('~all')).toBe(true);
    expect(issued.spf).toContain('include:amazonses.com');
    expect(issued.dkim).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect(issued.dmarc.startsWith('v=DMARC1;')).toBe(true);
  });

  it('verify once DNS returns those exact values', () => {
    expect(judgeIssuedRecord({ type: 'SPF', value: issued.spf }, { txt: [issued.spf], cname: [] }, issued.mechanisms).valid).toBe(true);
    const splitKey = issued.dkim.replace('p=', 'p= ').replace(/(.{60})/g, '$1 ');
    expect(judgeIssuedRecord({ type: 'DKIM', value: issued.dkim }, { txt: [splitKey], cname: [] }, []).valid).toBe(true);
    expect(judgeIssuedRecord({ type: 'DMARC', value: issued.dmarc }, { txt: [issued.dmarc], cname: [] }, []).valid).toBe(true);
    expect(judgeIssuedRecord({ type: 'TRACKING', value: issued.tracking }, { txt: [], cname: [issued.tracking] }, []).valid).toBe(true);
    expect(judgeIssuedRecord({ type: 'RETURN_PATH', value: issued.bounce }, { txt: [], cname: ['bounce.inboxflow.io.'] }, []).valid).toBe(true);
    expect(judgeIssuedRecord({ type: 'CUSTOM', value: issued.token }, { txt: [issued.token], cname: [] }, []).valid).toBe(true);
  });

  it('stays unverified until those records propagate', () => {
    const empty = { txt: [] as string[], cname: [] as string[] };
    expect(judgeIssuedRecord({ type: 'SPF', value: issued.spf }, empty, issued.mechanisms).valid).toBe(false);
    expect(judgeIssuedRecord({ type: 'DKIM', value: issued.dkim }, { txt: ['v=DKIM1; k=rsa; p=different'], cname: [] }, []).valid).toBe(false);
    expect(judgeIssuedRecord({ type: 'TRACKING', value: issued.tracking }, { txt: [], cname: ['somewhere.else'] }, []).valid).toBe(false);
  });
});
