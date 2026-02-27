import { RunStore } from '@deepagents/evals/store';

const store = new RunStore(process.env.EVALS_DB_PATH);
export default store;

export interface AppBindings {
  Variables: {
    store: RunStore;
  };
}
