import { type AgentStack, defineStack } from '@deepagents/experimental/zukhruf';

/** Each participant runs on the group's shared store, streams and mailbox, with its own queue. */
export default function participantStack(
  resources: Awaited<ReturnType<AgentStack>>,
) {
  return defineStack(async () => resources);
}
