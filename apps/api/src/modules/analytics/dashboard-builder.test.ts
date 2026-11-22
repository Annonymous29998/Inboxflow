import { describe, expect, it } from 'vitest';
import { standardEmailRates } from './engagement-rates.js';

describe('standardEmailRates', () => {
  it('matches ESP unique rates against delivered (sent minus bounces)', () => {
    const r = standardEmailRates({
      sent: 10_000,
      bounced: 50,
      opened: 70,
      clicked: 26,
    });
    expect(r.delivered).toBe(9_950);
    expect(r.deliveryRate).toBe(99.5);
    expect(r.bounceRate).toBe(0.5);
    expect(r.openRate).toBe(0.7);
    expect(r.clickRate).toBe(0.26);
    expect(r.clickToOpenRate).toBe(37.14);
  });

  it('does not report 100% delivery when there are bounces', () => {
    const r = standardEmailRates({ sent: 1_000, bounced: 20, opened: 0, clicked: 0 });
    expect(r.deliveryRate).toBe(98);
    expect(r.deliveryRate).toBeLessThan(100);
  });
});
