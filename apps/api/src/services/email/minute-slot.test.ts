import { describe, expect, it } from 'vitest';
import { msUntilMinuteSlot } from './minute-slot.js';

describe('msUntilMinuteSlot', () => {
  const now = 1_000_000;

  it('sends immediately while the minute still has room', () => {
    const sent = Array.from({ length: 79 }, (_, i) => now - 50_000 + i);
    expect(msUntilMinuteSlot(sent, [], 80, now)).toBe(0);
  });

  it('waits once until the oldest send leaves the minute', () => {
    const oldest = now - 12_000;
    const sent = [oldest, ...Array.from({ length: 79 }, (_, i) => now - 1_000 + i)];
    expect(msUntilMinuteSlot(sent, [], 80, now)).toBe(48_025);
  });

  it('counts a reserved send so the next worker does not take the same slot', () => {
    const sent = Array.from({ length: 79 }, () => now - 1_000);
    expect(msUntilMinuteSlot(sent, [now], 80, now)).toBe(59_025);
  });

  it('does not restart a short poll when the real wait is longer than 5 seconds', () => {
    const oldest = now - 40_000;
    const sent = Array.from({ length: 80 }, (_, i) => oldest + i * 100);
    const wait = msUntilMinuteSlot(sent, [], 80, now);
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBe(oldest + 60_000 - now + 25);
  });
});
