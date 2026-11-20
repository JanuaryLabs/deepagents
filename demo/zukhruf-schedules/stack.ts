import { fromPglite } from 'pg-boss';

import {
  EmbeddedAgentStorage,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { schedulesCapabilities } from '@deepagents/experimental/zukhruf/schedules';

export default defineStack(async (resources) => {
  const storage = resources.use(
    await EmbeddedAgentStorage.open({ directory: import.meta.dirname }),
  );
  return {
    storage,
    bindings: [
      schedulesCapabilities.boss.bind(storage.boss),
      schedulesCapabilities.transaction.bind((operation) =>
        storage.queueDatabase.transaction((transaction) =>
          operation(fromPglite(transaction)),
        ),
      ),
    ],
  };
});
