import {
  type AgentStorage,
  defineStack,
} from '@deepagents/experimental/zukhruf';

/** Each participant runs on its own storage, whose queue only its runtime consumes. */
export default function participantStack(storage: AgentStorage) {
  return defineStack(async () => ({ storage }));
}
