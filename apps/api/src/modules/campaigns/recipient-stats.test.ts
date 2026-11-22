import { describe, expect, it } from 'vitest';
import { normalizeSentFailed } from './recipient-stats.js';

describe('normalizeSentFailed', () => {
  it('peels failures off a processed-as-sent counter', () => {
    expect(normalizeSentFailed(2399, 9, 2399)).toEqual({ sent: 2390, failed: 9 });
  });

  it('keeps honest SMTP-accepted counts', () => {
    expect(normalizeSentFailed(2390, 9, 2399)).toEqual({ sent: 2390, failed: 9 });
  });

  it('leaves a clean send alone', () => {
    expect(normalizeSentFailed(2399, 0, 2399)).toEqual({ sent: 2399, failed: 0 });
  });
});
