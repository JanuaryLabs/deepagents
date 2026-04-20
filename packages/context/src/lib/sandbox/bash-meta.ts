import { AsyncLocalStorage } from 'node:async_hooks';

export interface BashMetaState {
  hidden: Record<string, unknown>;
  reminder?: string;
}

const store = new AsyncLocalStorage<BashMetaState>();

export function runWithBashMeta<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ hidden: {} }, fn);
}

export interface BashMetaHandle {
  setHidden(patch: Record<string, unknown>): void;
  setReminder(text: string): void;
  clearReminder(): void;
}

export function useBashMeta(): BashMetaHandle | null {
  const state = store.getStore();
  if (!state) return null;
  return {
    setHidden(patch) {
      state.hidden = { ...state.hidden, ...patch };
    },
    setReminder(text) {
      state.reminder = text;
    },
    clearReminder() {
      state.reminder = undefined;
    },
  };
}

export function readBashMeta(): BashMetaState | undefined {
  return store.getStore();
}
