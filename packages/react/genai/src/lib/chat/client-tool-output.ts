import type { UseChatHelpers } from '@ai-sdk/react';

import type { ComponentRegistry } from '../tools/registry.ts';
import type { AgentUIMessage } from './agent-ui-message.ts';

type ChatHelpers = UseChatHelpers<AgentUIMessage>;

interface ToolCall {
  toolCallId: string;
  toolName: string;
}

export async function completeRenderedClientTool(
  chat: Pick<ChatHelpers, 'addToolOutput'>,
  registry: ComponentRegistry | undefined,
  toolCall: ToolCall,
): Promise<void> {
  const clientTool = registry?.[toolCall.toolName];
  if (
    toolCall.toolName.startsWith('render') &&
    clientTool?.static === false &&
    clientTool.requiresUserInput !== true
  ) {
    await chat.addToolOutput({
      toolCallId: toolCall.toolCallId,
      tool: toolCall.toolName,
      output: 'rendered',
      state: 'output-available',
    });
  }
}
