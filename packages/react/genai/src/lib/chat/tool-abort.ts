import type { ChatStatus, ToolUIPart } from 'ai';

import { useAgentStatus } from './agent-context.tsx';

export function isToolStateAborted(
  state: ToolUIPart['state'] | undefined,
  status: ChatStatus,
): boolean {
  if (status === 'streaming' || status === 'submitted') return false;
  return state === 'input-streaming' || state === 'input-available';
}

export function isToolAborted(part: ToolUIPart, status: ChatStatus): boolean {
  return isToolStateAborted(part.state, status);
}

export function useIsToolAborted(part: ToolUIPart): boolean {
  const { status } = useAgentStatus();
  return isToolAborted(part, status);
}
