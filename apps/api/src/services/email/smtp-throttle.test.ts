import { describe, expect, it } from 'vitest';
import { isSmtpAccountBlockError, isSmtpThrottleError } from './smtp-throttle.js';

describe('isSmtpAccountBlockError', () => {
  it('trips on 535 auth and 554 policy', () => {
    expect(isSmtpAccountBlockError('Invalid login: 535 5.7.8 Error')).toBe(true);
    expect(isSmtpAccountBlockError('554 5.7.1 Relay access denied')).toBe(true);
    expect(isSmtpAccountBlockError('535 Authentication failed')).toBe(true);
  });

  it('does not trip on 250 accept or mailbox 550', () => {
    expect(isSmtpAccountBlockError('250 2.0.0 OK queued')).toBe(false);
    expect(isSmtpAccountBlockError('550 5.1.1 User unknown')).toBe(false);
    expect(isSmtpAccountBlockError('')).toBe(false);
  });

  it('does not treat 421 throttle as an account block', () => {
    expect(isSmtpThrottleError('421 4.7.0 Try again later')).toBe(true);
    expect(isSmtpAccountBlockError('421 4.7.0 Try again later')).toBe(false);
  });
});
