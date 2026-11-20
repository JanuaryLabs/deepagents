import {
  EmbeddedAgentStorage,
  defineStack,
} from '@deepagents/experimental/zukhruf';

export default defineStack(async (resources) => ({
  storage: resources.use(
    await EmbeddedAgentStorage.open({ directory: import.meta.dirname }),
  ),
}));
