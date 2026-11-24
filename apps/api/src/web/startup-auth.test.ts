import { describe, expect, it } from 'vitest';
import { isUnauthorizedError } from '../../../web/src/lib/startup-auth.ts';

describe('startup unauthorized toast', () => {
  it('recognizes the refusal that flashes when Campaigns opens', () => {
    expect(isUnauthorizedError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(true);
    expect(isUnauthorizedError(new Error('Unauthorized'))).toBe(true);
    expect(isUnauthorizedError(new Error('Could not load campaigns'))).toBe(false);
  });
});
