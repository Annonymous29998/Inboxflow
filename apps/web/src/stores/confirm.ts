import { create } from 'zustand';

export type ConfirmTone = 'default' | 'danger' | 'warning' | 'info';

export type ConfirmConfig = {
  id: string;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
  destructive?: boolean;
  resolve: (value: boolean) => void;
};

export type PromptConfig = {
  id: string;
  title: string;
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  validate?: (value: string) => string | null;
  resolve: (value: string | null) => void;
};

type ConfirmState = {
  activeConfirm: ConfirmConfig | null;
  activePrompt: PromptConfig | null;
  openConfirm: (cfg: Omit<ConfirmConfig, 'id' | 'resolve'>) => Promise<boolean>;
  closeConfirm: (value: boolean) => void;
  openPrompt: (cfg: Omit<PromptConfig, 'id' | 'resolve'>) => Promise<string | null>;
  closePrompt: (value: string | null) => void;
};

function nextId() {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  activeConfirm: null,
  activePrompt: null,

  openConfirm: (cfg) =>
    new Promise<boolean>((resolve) => {
      set({ activeConfirm: { id: nextId(), resolve, ...cfg } });
    }),

  closeConfirm: (value) => {
    const cfg = get().activeConfirm;
    cfg?.resolve(value);
    set({ activeConfirm: null });
  },

  openPrompt: (cfg) =>
    new Promise<string | null>((resolve) => {
      set({ activePrompt: { id: nextId(), resolve, ...cfg } });
    }),

  closePrompt: (value) => {
    const cfg = get().activePrompt;
    cfg?.resolve(value);
    set({ activePrompt: null });
  },
}));

/** Imperative API from any component/handler */
export function confirmDialog(
  message: string | { title: string; description?: string; tone?: ConfirmTone; confirmText?: string; cancelText?: string; destructive?: boolean },
): Promise<boolean> {
  const cfg = typeof message === 'string' ? { title: message } : message;
  return useConfirmStore.getState().openConfirm(cfg);
}

export function promptDialog(
  title: string,
  opts?: { placeholder?: string; defaultValue?: string; description?: string; confirmText?: string; cancelText?: string; validate?: (v: string) => string | null },
): Promise<string | null> {
  return useConfirmStore.getState().openPrompt({
    title,
    placeholder: opts?.placeholder,
    defaultValue: opts?.defaultValue,
    description: opts?.description,
    confirmText: opts?.confirmText,
    cancelText: opts?.cancelText,
    validate: opts?.validate,
  });
}
