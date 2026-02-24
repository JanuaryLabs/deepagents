import type { RunStore } from '../../store/index.ts';

export interface WebBindings {
  Variables: {
    store: RunStore;
  };
}
