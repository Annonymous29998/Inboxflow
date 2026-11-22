import { describe, expect, it } from 'vitest';
import { campaignListPagePlan } from './campaign-list-order.js';

describe('campaignListPagePlan', () => {
  it('puts drafts on page 1 before any sent rows', () => {
    expect(campaignListPagePlan(5, 1, 20)).toEqual({
      draftSkip: 0,
      draftTake: 5,
      sentSkip: 0,
      sentTake: 15,
    });
  });

  it('fills page 1 with drafts only when there are enough', () => {
    expect(campaignListPagePlan(25, 1, 20)).toEqual({
      draftSkip: 0,
      draftTake: 20,
      sentSkip: 0,
      sentTake: 0,
    });
  });

  it('continues drafts then sent on page 2', () => {
    expect(campaignListPagePlan(25, 2, 20)).toEqual({
      draftSkip: 20,
      draftTake: 5,
      sentSkip: 0,
      sentTake: 15,
    });
  });

  it('skips into sent history after drafts are exhausted', () => {
    expect(campaignListPagePlan(5, 2, 20)).toEqual({
      draftSkip: 0,
      draftTake: 0,
      sentSkip: 15,
      sentTake: 20,
    });
  });
});
