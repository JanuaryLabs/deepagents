import type { RunStore } from '@deepagents/evals/store';

export interface WebBindings {
  Variables: {
    store: RunStore;
  };
}
