import { describe, expect, it } from 'vitest';
import { fromCursorSlot, smtpFromRotationGrid } from './smtp-rotation.js';

describe('smtpFromRotationGrid', () => {
  it('uses From 1 on every SMTP before From 2', () => {
    expect(smtpFromRotationGrid(5, 3, 15)).toEqual([
      { smtp: 1, from: 1 },
      { smtp: 2, from: 1 },
      { smtp: 3, from: 1 },
      { smtp: 4, from: 1 },
      { smtp: 5, from: 1 },
      { smtp: 1, from: 2 },
      { smtp: 2, from: 2 },
      { smtp: 3, from: 2 },
      { smtp: 4, from: 2 },
      { smtp: 5, from: 2 },
      { smtp: 1, from: 3 },
      { smtp: 2, from: 3 },
      { smtp: 3, from: 3 },
      { smtp: 4, from: 3 },
      { smtp: 5, from: 3 },
    ]);
  });

  it('does not drain SMTP 1 Froms before SMTP 2', () => {
    const firstFive = smtpFromRotationGrid(2, 4, 5);
    expect(firstFive).toEqual([
      { smtp: 1, from: 1 },
      { smtp: 2, from: 1 },
      { smtp: 1, from: 2 },
      { smtp: 2, from: 2 },
      { smtp: 1, from: 3 },
    ]);
  });

  it('wraps From 1–4 independently per SMTP', () => {
    const rows = smtpFromRotationGrid(2, 4, 9);
    expect(rows[7]).toEqual({ smtp: 2, from: 4 });
    expect(rows[8]).toEqual({ smtp: 1, from: 1 });
  });
});

describe('fromCursorSlot', () => {
  it('returns 0,1,2,3 then wraps', () => {
    let cursor = 0;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const slot = fromCursorSlot(cursor, 4);
      seen.push(slot.index);
      cursor = slot.next;
    }
    expect(seen).toEqual([0, 1, 2, 3, 0, 1]);
  });
});
