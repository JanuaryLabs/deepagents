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
  isToolUIPart,
} from 'ai';

import type { AgentModel } from './advisor.ts';
import type { ContextEngine } from './engine.ts';
import type { AgentSandbox } from './sandbox/types.ts';
import { TitleGenerator } from './title.ts';

export interface ChatAgentLike<CIn> {
  context?: ContextEngine;
  model?: AgentModel;
  sandbox: AgentSandbox;
  stream(
    contextVariables: CIn,
    config?: {
      abortSignal?: AbortSignal;
      transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
      maxRetries?: number;
    },
  ): Promise<StreamTextResult<ToolSet, never>>;
}

export type ChatMessageMetadata = NonNullable<
  Parameters<StreamTextResult<ToolSet, never>['toUIMessageStream']>[0]
>['messageMetadata'];

export const defaultChatMessageMetadata: NonNullable<ChatMessageMetadata> = ({
  part,
}) => {
  if (part.type === 'finish-step') {
    return { finishReason: part.finishReason, usage: part.usage };
  }
  if (part.type === 'finish') {
    return { finishReason: part.finishReason, totalUsage: part.totalUsage };
  }
  return undefined;
};

export interface ChatOptions<CIn> {
  contextVariables?: CIn;
  transform?: StreamTextTransform<ToolSet> | StreamTextTransform<ToolSet>[];
  abortSignal?: AbortSignal;
  generateTitle?: boolean;
  onError?: (error: unknown) => string;
  messageMetadata?: ChatMessageMetadata;
  finalAssistantMetadata?: (
    message: UIMessage,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
}

/**
 * Stream an assistant turn into the conversation context.
 *
 * **Precondition:** the chain head must be an assistant fragment. This is
 * established by calling `context.continue(input)` first — that method
 * appends the input and reserves an empty assistant placeholder whose id
 * becomes the streaming target. `chat()` throws if the precondition is
 * violated (caller forgot `continue()` or used manual `set + save`).
 *
 * The streamed content is written to that placeholder in place
 * (`branch: false`), and on finish usage is tracked via `context.trackUsage`.
 *
 * @example
 * ```ts
 * await context.continue(user('hi'));
 * const stream = await chat(agent);
 * ```
 */
export async function chat<CIn>(
  agent: ChatAgentLike<CIn>,
  options: ChatOptions<CIn> = {},
) {
  const context = agent.context;
  if (!context) {
    throw new Error(
      'Agent is missing a context. Provide context when creating the agent.',
    );
  }

  const head = await context.headMessage();
  if (head?.name !== 'assistant') {
    throw new Error(
      'chat: expected an assistant message at head. Call context.continue(input) before chat().',
    );
  }
  const initialAssistantMsgId = head.id;
  const uiMessages = await context.getMessages();

  const streamContextVariables =
    options.contextVariables === undefined
      ? ({} as CIn)
      : options.contextVariables;

  const [title, result] = await Promise.all([
    makeTitle({
      context,
      model: agent.model,
      generateTitle: options.generateTitle,
      abortSignal: options.abortSignal,
    }),
    agent.stream(streamContextVariables, {
      transform: options.transform,
      abortSignal: options.abortSignal,
    }),
  ]);

  const uiStream = result.toUIMessageStream({
    onError: options.onError ?? formatChatError,
    sendStart: true,
    sendFinish: true,
    sendReasoning: true,
    sendSources: true,
    originalMessages: uiMessages,
    generateMessageId: () => initialAssistantMsgId,
    messageMetadata: options.messageMetadata ?? defaultChatMessageMetadata,
  });

  return createUIMessageStream({
    originalMessages: uiMessages,
    generateId: () => initialAssistantMsgId,
    onStepFinish: async ({ responseMessage }) => {
      await context.writeAssistantSegment(responseMessage as UIMessage);
    },
    onFinish: async ({ responseMessage, isAborted }) => {
      let message = responseMessage as UIMessage;
      if (isAborted) {
        message = { ...message, parts: sanitizeAbortedParts(message.parts) };
      }

      const finalMetadata = await options.finalAssistantMetadata?.(message);
      const mergedMetadata = {
        ...((message.metadata as object) ?? {}),
        ...(finalMetadata ?? {}),
      };
      if (Object.keys(mergedMetadata).length > 0) {
        message = { ...message, metadata: mergedMetadata } as UIMessage;
      }

      await context.writeAssistantSegment(message);
      await context.trackUsage(await result.totalUsage);
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
    if (part.state === 'input-streaming') continue;
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

async function makeTitle(options: {
  context: ContextEngine;
  model?: AgentModel;
  generateTitle?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string | null> {
  const titler = new TitleGenerator({ context: options.context });

  if (options.generateTitle && !options.model) {
    console.warn(
      'chat: generateTitle=true but agent.model is unset; using static title.',
    );
  }

  const result =
    options.generateTitle && options.model
      ? await titler.ensure({
          model: options.model,
          abortSignal: options.abortSignal,
        })
      : await titler.ensureStatic();

  return result?.title ?? null;
}
