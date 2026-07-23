import { create } from 'zustand';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export type ToastItem = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  createdAt: number;
};

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
};

type ToastState = {
  items: ToastItem[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
};

const DEFAULT_DURATION = 4200;

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (input) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: ToastItem = {
      id,
      title: input.title,
      description: input.description,
      tone: input.tone ?? 'info',
      createdAt: Date.now(),
    };
    set((s) => ({ items: [...s.items.slice(-4), item] }));
    const ms = input.durationMs ?? DEFAULT_DURATION;
    if (ms > 0) {
      window.setTimeout(() => get().dismiss(id), ms);
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
    useToastStore.getState().push({ title, description, tone: 'error', durationMs: 6000 }),
  warning: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'warning' }),
  info: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, tone: 'info' }),
};
