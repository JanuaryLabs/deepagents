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
  isToolUIPart,
} from 'ai';

import type { AgentModel } from './advisor.ts';
import type { ContextEngine } from './engine.ts';
import {
  type MessageFragment,
  assistant,
  isFragment,
  isMessageFragment,
  message,
} from './fragments.ts';
import { generateChatTitle, staticChatTitle } from './title.ts';

export type ChatMessage = UIMessage | MessageFragment;

export function toMessageFragment(item: ChatMessage): MessageFragment {
  if (isFragment(item) && isMessageFragment(item)) {
    return item;
  }
  return message(item);
}

export function chatMessageToUIMessage(item: ChatMessage): UIMessage {
  if (isFragment(item) && isMessageFragment(item)) {
    return item.codec.encode() as UIMessage;
  }
  return item;
}

export interface ChatAgentLike<CIn> {
  context?: ContextEngine;
  model?: AgentModel;
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
  abortSignal?: AbortSignal;
  generateTitle?: boolean;
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
  messages: ChatMessage[],
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

  const lastItem = messages[messages.length - 1];
  const lastFragment = toMessageFragment(lastItem);
  const lastUIMessage = chatMessageToUIMessage(lastItem);
  let assistantMsgId: string;

  if (lastUIMessage.role === 'assistant') {
    context.set(lastFragment);
    await context.save({ branch: false });
    assistantMsgId = lastUIMessage.id;
  } else {
    context.set(lastFragment);
    await context.save();
    assistantMsgId = generateId();
  }

  const uiMessages = messages.map(chatMessageToUIMessage);

  let title: string | null = null;
  if (!context.chat?.title) {
    const firstUserMsg = uiMessages.find((m) => m.role === 'user');
    if (firstUserMsg) {
      if (options?.generateTitle && agent.model) {
        title = await generateChatTitle({
          message: firstUserMsg,
          model: agent.model,
          abortSignal: options?.abortSignal,
        });
      } else {
        title = staticChatTitle(firstUserMsg);
      }
      await context.updateChat({ title });
    }
  }

  const streamContextVariables =
    options?.contextVariables === undefined
      ? ({} as CIn)
      : options.contextVariables;

  const result = await agent.stream(streamContextVariables, {
    transform: options?.transform,
    abortSignal: options?.abortSignal,
  });

  const uiStream = result.toUIMessageStream({
    onError: options?.onError ?? formatChatError,
    sendStart: true,
    sendFinish: true,
    sendReasoning: true,
    sendSources: true,
    originalMessages: uiMessages,
    generateMessageId: () => assistantMsgId,
    messageMetadata: options?.messageMetadata,
  });

  return createUIMessageStream({
    originalMessages: uiMessages,
    generateId: () => assistantMsgId,
    onStepFinish: async ({ responseMessage }) => {
      const normalizedMessage = {
        ...responseMessage,
        id: assistantMsgId,
      } as UIMessage;
      context.set(assistant(normalizedMessage));
      await context.save({ branch: false });
    },
    onFinish: async ({ responseMessage, isAborted }) => {
      const normalizedMessage = {
        ...responseMessage,
        id: assistantMsgId,
      } as UIMessage;

      if (isAborted) {
        normalizedMessage.parts = sanitizeAbortedParts(normalizedMessage.parts);
      }

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

      if (title) {
        writer.write({ type: 'data-chat-title', data: title });
      }
    },
  });
}

const TERMINAL_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
]);

function sanitizeAbortedParts(parts: UIMessage['parts']): UIMessage['parts'] {
  const sanitized: UIMessage['parts'] = [];
  for (const part of parts) {
    if (!isToolUIPart(part)) {
      sanitized.push(part);
      continue;
    }

    if (TERMINAL_TOOL_STATES.has(part.state)) {
      sanitized.push(part);
      continue;
    }

    if (part.state === 'input-streaming') {
      continue;
    }

    sanitized.push({
      ...part,
      state: 'output-error',
      errorText: 'Cancelled by user',
    } as (typeof sanitized)[number]);
  }
  return sanitized;
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
