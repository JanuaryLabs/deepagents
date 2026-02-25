import {
  APICallError,
  InvalidToolInputError,
  NoSuchToolError,
  type StreamTextResult,
  type StreamTextTransform,
  ToolCallRepairError,
  type ToolSet,
  type UIMessage,
  createUIMessageStream,
  generateId,
} from 'ai';

import type { ContextEngine } from './engine.ts';
import { assistant, message } from './fragments.ts';

export interface ChatAgentLike<CIn> {
  context?: ContextEngine;
  stream(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
      maxRetries?: number;
    },
  ): Promise<StreamTextResult<ToolSet, never>>;
}

export interface ChatOptions<CIn> {
  contextVariables?: CIn;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
  generateMessageId?: () => string;
  onError?: (error: unknown) => string;
  messageMetadata?: NonNullable<
    Parameters<StreamTextResult<ToolSet, never>['toUIMessageStream']>[0]
  >['messageMetadata'];
  finalAssistantMetadata?: (
    message: UIMessage,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
}

export async function chat<CIn>(
  agent: ChatAgentLike<CIn>,
  messages: UIMessage[],
  options?: ChatOptions<CIn>,
) {
  const context = agent.context;
  if (!context) {
    throw new Error(
      'Agent is missing a context. Provide context when creating the agent.',
    );
  }

  if (messages.length === 0) {
    throw new Error('messages must not be empty');
  }

  const lastMessage = messages[messages.length - 1];
  let assistantMsgId: string;

  if (lastMessage.role === 'assistant') {
    context.set(message(lastMessage));
    await context.save({ branch: false });
    assistantMsgId = lastMessage.id;
  } else {
    context.set(message(lastMessage));
    await context.save();
    assistantMsgId = options?.generateMessageId?.() ?? generateId();
  }

  const streamContextVariables =
    options?.contextVariables === undefined
      ? ({} as CIn)
      : options.contextVariables;

  const result = await agent.stream(streamContextVariables, {
    transform: options?.transform,
  });

  const uiStream = result.toUIMessageStream({
    onError: options?.onError ?? formatChatError,
    sendStart: true,
    sendFinish: true,
    sendReasoning: true,
    sendSources: true,
    originalMessages: messages,
    generateMessageId: () => assistantMsgId,
    messageMetadata: options?.messageMetadata,
  });

  return createUIMessageStream({
    originalMessages: messages,
    generateId: () => assistantMsgId,
    onStepFinish: async ({ responseMessage }) => {
      const normalizedMessage = {
        ...responseMessage,
        id: assistantMsgId,
      } as UIMessage;
      context.set(assistant(normalizedMessage));
      await context.save({ branch: false });
    },
    onFinish: async ({ responseMessage }) => {
      const normalizedMessage = {
        ...responseMessage,
        id: assistantMsgId,
      } as UIMessage;
      const finalMetadata =
        await options?.finalAssistantMetadata?.(normalizedMessage);
      const finalMessage =
        finalMetadata === undefined
          ? normalizedMessage
          : ({
              ...normalizedMessage,
              metadata: {
                ...((normalizedMessage.metadata as object) ?? {}),
                ...finalMetadata,
              },
            } as UIMessage);

      context.set(assistant(finalMessage));
      await context.save({ branch: false });

      const totalUsage = await result.totalUsage;
      await context.trackUsage(totalUsage);
    },
    execute: async ({ writer }) => {
      writer.merge(uiStream);
    },
  });
}

function formatChatError(error: unknown): string {
  if (NoSuchToolError.isInstance(error)) {
    return 'The model tried to call an unknown tool.';
  }
  if (InvalidToolInputError.isInstance(error)) {
    return 'The model called a tool with invalid arguments.';
  }
  if (ToolCallRepairError.isInstance(error)) {
    return 'The model tried to call a tool with invalid arguments, but it was repaired.';
  }
  if (APICallError.isInstance(error)) {
    console.error('Upstream API call failed:', error);
    return `Upstream API call failed with status ${error.statusCode}: ${error.message}`;
  }
  return JSON.stringify(error);
}
