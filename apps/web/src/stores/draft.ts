import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { currentAccountId } from '@/lib/account-scope';

type DraftState = {
  drafts: Record<string, unknown>;
  setDraft: <T>(key: string, value: T) => void;
  getDraft: <T>(key: string, fallback: T) => T;
  clearDraft: (key: string) => void;
  clearAllDrafts: () => void;
};

const STORAGE_KEY = 'inboxflow-drafts';

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      setDraft: <T,>(key: string, value: T) =>
        set((s) => ({ drafts: { ...s.drafts, [`${currentAccountId()}::${key}`]: value } })),
      getDraft: <T,>(key: string, fallback: T): T => {
        const stored = get().drafts[`${currentAccountId()}::${key}`];
        return (stored as T) ?? fallback;
      },
      clearDraft: (key: string) =>
        set((s) => {
          const next = { ...s.drafts };
          delete next[`${currentAccountId()}::${key}`];
          return { drafts: next };
        }),
      clearAllDrafts: () => set({ drafts: {} }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ drafts: state.drafts }),
    },
  ),
);

export function useDraft<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const drafts = useDraftStore((s) => s.drafts);
  const setDraft = useDraftStore((s) => s.setDraft);
  const clearDraft = useDraftStore((s) => s.clearDraft);

  const scoped = `${currentAccountId()}::${key}`;
  const value = (drafts[scoped] as T) ?? fallback;

  const update = (v: T | ((prev: T) => T)) => {
    if (typeof v === 'function') {
      const fn = v as (prev: T) => T;
      const stored = useDraftStore.getState().drafts;
      const latest = Object.prototype.hasOwnProperty.call(stored, scoped) ? (stored[scoped] as T) : value;
      setDraft<T>(key, fn(latest ?? fallback));
    } else {
      setDraft<T>(key, v);
    }
  };

  return [value, update, () => clearDraft(key)];
}
