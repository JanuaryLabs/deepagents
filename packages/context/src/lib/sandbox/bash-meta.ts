import { AsyncLocalStorage } from 'node:async_hooks';

export interface BashMetaState {
  hidden: Record<string, unknown>;
}

const store = new AsyncLocalStorage<BashMetaState>();

export function runWithBashMeta<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ hidden: {} }, fn);
}

export interface BashMetaHandle {
  setHidden(patch: Record<string, unknown>): void;
}

export function useBashMeta(): BashMetaHandle | null {
  const state = store.getStore();
  if (!state) return null;
  return {
    setHidden(patch) {
      state.hidden = { ...state.hidden, ...patch };
    },
  };
}

export function readBashMeta(): BashMetaState | undefined {
  return store.getStore();
}
