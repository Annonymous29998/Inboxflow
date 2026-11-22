/** Drafts (never sent) first, then sent history. Pagination spans both buckets. */

export function campaignListPagePlan(draftCount: number, page: number, limit: number) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const skip = (safePage - 1) * safeLimit;
  const drafts = Math.max(0, draftCount);

  if (skip < drafts) {
    const draftTake = Math.min(safeLimit, drafts - skip);
    return {
      draftSkip: skip,
      draftTake,
      sentSkip: 0,
      sentTake: Math.max(0, safeLimit - draftTake),
    };
  }

  return {
    draftSkip: 0,
    draftTake: 0,
    sentSkip: skip - drafts,
    sentTake: safeLimit,
  };
}
