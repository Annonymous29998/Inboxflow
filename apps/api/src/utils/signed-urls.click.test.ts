import { describe, expect, it } from 'vitest';
import {
  decodeClickTicket,
  decodeRelayClickTicket,
  encodeClickTicket,
  encodeRelayClickTicket,
  resolveClickDest,
  signOpen,
  signRelayOpen,
  signRelayUnsubscribe,
  verifyOpen,
  verifyRelayOpen,
  verifyRelayUnsubscribe,
} from './signed-urls.js';

describe('click tickets', () => {
  it('encodes dest and rejects tampering', () => {
    const t = encodeClickTicket('camp', 'ct', 'https://inboxflow.io/sale');
    expect(t).not.toContain('inboxflow.io/sale');
    expect(decodeClickTicket('camp', 'ct', t)).toBe('https://inboxflow.io/sale');
    expect(decodeClickTicket('camp', 'other', t)).toBeNull();
    expect(decodeClickTicket('camp', 'ct', `${t}x`)).toBeNull();
    expect(resolveClickDest('camp', 'ct', { t })).toBe('https://inboxflow.io/sale');
  });

  it('signs open pixels and rejects a missing or wrong signature', () => {
    const s = signOpen('ct', 'camp');
    expect(verifyOpen('ct', 'camp', s)).toBe(true);
    expect(verifyOpen('ct', 'camp', undefined)).toBe(false);
    expect(verifyOpen('ct', 'camp', `${s}x`)).toBe(false);
    expect(verifyOpen('other', 'camp', s)).toBe(false);
  });

  it('signs public-site relay links for a PC-hosted campaign', () => {
    const open = signRelayOpen('org', 'ct', 'camp');
    expect(verifyRelayOpen('org', 'ct', 'camp', open)).toBe(true);
    expect(verifyRelayOpen('other', 'ct', 'camp', open)).toBe(false);
    const unsub = signRelayUnsubscribe('org', 'ct', 'camp');
    expect(verifyRelayUnsubscribe('org', 'ct', 'camp', unsub)).toBe(true);
    const ticket = encodeRelayClickTicket('org', 'camp', 'ct', 'https://example.com/offer');
    expect(decodeRelayClickTicket('camp', 'ct', ticket)).toEqual({
      url: 'https://example.com/offer',
      orgId: 'org',
    });
    expect(decodeRelayClickTicket('camp', 'other', ticket)).toBeNull();
  });
});
