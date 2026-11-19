import { describe, expect, it } from 'vitest';
import { decodeClickTicket, encodeClickTicket, resolveClickDest, signOpen, verifyOpen } from './signed-urls.js';

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
});
