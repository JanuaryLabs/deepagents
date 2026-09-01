import type { UIMessage, UseChatHelpers } from '@ai-sdk/react';
import type { UIDataTypes, UITools } from 'ai';

import type { ComponentRegistry } from '../tools/registry.ts';

type ChatHelpers = UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>;

interface ToolCall {
  toolCallId: string;
  toolName: string;
}

export async function completeRenderedClientTool(
  chat: ChatHelpers,
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
