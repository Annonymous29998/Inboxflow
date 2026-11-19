import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  createdAt: number;
  durationMs: number;
};

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Auto-dismiss after ms. Default 2000. Pass 0 to keep until the user clicks X. */
  durationMs?: number;
};

export const TOAST_TTL_MS = 2000;

type ToastState = {
  items: ToastItem[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (input) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const durationMs = input.durationMs ?? TOAST_TTL_MS;
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'info',
      createdAt: Date.now(),
      durationMs,
    };
    set((s) => ({ items: [...s.items.slice(-1), item] }));
    if (durationMs > 0) {
      window.setTimeout(() => get().dismiss(id), durationMs);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Imperative helpers — use from any page/action handler */
export const toast = {
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'success' }),
  error: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'error' }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'warning' }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'info' }),
};
