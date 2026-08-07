import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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
        set((s) => ({ drafts: { ...s.drafts, [key]: value } })),
      getDraft: <T,>(key: string, fallback: T): T => {
        const stored = get().drafts[key];
        return (stored as T) ?? fallback;
      },
      clearDraft: (key: string) =>
        set((s) => {
          const next = { ...s.drafts };
          delete next[key];
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

  const value = (drafts[key] as T) ?? fallback;

  const update = (v: T | ((prev: T) => T)) => {
    if (typeof v === 'function') {
      const fn = v as (prev: T) => T;
      setDraft<T>(key, fn(value));
    } else {
      setDraft<T>(key, v);
    }
  };

  return [value, update, () => clearDraft(key)];
}
