import {
  APICallError,
  InvalidToolInputError,
  type LanguageModelUsage,
  NoSuchToolError,
  ToolCallRepairError,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOptions,
  type UIMessageStreamWriter,
  createUIMessageStream,
  isToolUIPart,
} from 'ai';

import type { AgentModel } from './advisor.ts';
import type { StreamOptions, ToolCallArguments } from './agent.ts';
import type { ContextEngine } from './engine.ts';
import { isRecord } from './fragments/reminders/index.ts';
import type { AgentSandbox } from './sandbox/types.ts';
import { TitleGenerator } from './title.ts';

type ChatConfig<TOOLS extends ToolSet> = Omit<
  StreamOptions<TOOLS>,
  'maxRetries'
> & {
  /** Native writer for data parts, available before the first model request. */
  onStream?: (writer: UIMessageStreamWriter) => void;
  generateTitle?: boolean;
  onError?: (error: unknown) => string;
  messageMetadata?: ChatMessageMetadata;
  finalAssistantMetadata?: (
    message: UIMessage,
  ) =>
    | Record<string, unknown>
    | undefined
    | Promise<Record<string, unknown> | undefined>;
};

/** The part of an agent's stream result that `chat()` consumes. */
export interface ChatStreamResult {
  toUIMessageStream(
    options?: UIMessageStreamOptions<UIMessage>,
  ): ReadableStream<UIMessageChunk>;
  /** AI SDK v7 can settle an aborted stream without usage data. */
  readonly usage: PromiseLike<LanguageModelUsage | undefined>;
}

export interface ChatAgentLike<TOOLS extends ToolSet = {}> {
  context?: ContextEngine;
  model?: AgentModel;
  sandbox: AgentSandbox;
  tools?: TOOLS;
  stream(
    ...args: ToolCallArguments<TOOLS, ChatConfig<TOOLS>>
  ): Promise<ChatStreamResult>;
}

export type ChatMessageMetadata =
  UIMessageStreamOptions<UIMessage>['messageMetadata'];

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

export type ChatOptions<TOOLS extends ToolSet> = NonNullable<
  ToolCallArguments<TOOLS, ChatConfig<TOOLS>>[0]
>;

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
export async function chat<const TOOLS extends ToolSet>(
  agent: ChatAgentLike<TOOLS>,
  ...args: ToolCallArguments<NoInfer<TOOLS>, ChatConfig<NoInfer<TOOLS>>>
) {
  const [options] = args;
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

  let result: Awaited<ReturnType<typeof agent.stream>> | undefined;

  return createUIMessageStream({
    originalMessages: uiMessages,
    generateId: () => initialAssistantMsgId,
    onError: options?.onError ?? formatChatError,
    onStepEnd: async ({ responseMessage }) => {
      await context.writeAssistantSegment(responseMessage);
    },
    onEnd: async ({ responseMessage, isAborted }) => {
      const settled = isAborted
        ? {
            ...responseMessage,
            parts: sanitizeAbortedParts(responseMessage.parts),
          }
        : responseMessage;

      const finalMetadata = await options?.finalAssistantMetadata?.(settled);
      const mergedMetadata = {
        ...(isRecord(settled.metadata) ? settled.metadata : {}),
        ...(finalMetadata ?? {}),
      };
      const message =
        Object.keys(mergedMetadata).length > 0
          ? { ...settled, metadata: mergedMetadata }
          : settled;

      await context.writeAssistantSegment(message);
      const usage = await result?.usage;
      // The provider may never have emitted a finish chunk.
      if (usage !== undefined) {
        await context.trackUsage(usage);
      }
    },
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageId: initialAssistantMsgId });
      options?.onStream?.(writer);
      const [title, streamed] = await Promise.all([
        makeTitle({
          context,
          model: agent.model,
          generateTitle: options?.generateTitle,
          abortSignal: options?.abortSignal,
        }),
        agent.stream(...args),
      ]);
      result = streamed;
      writer.merge(
        result.toUIMessageStream({
          onError: options?.onError ?? formatChatError,
          sendStart: false,
          sendReasoning: true,
          sendSources: true,
          originalMessages: uiMessages,
          generateMessageId: () => initialAssistantMsgId,
          messageMetadata:
            options?.messageMetadata ?? defaultChatMessageMetadata,
        }),
      );
      if (title) {
        writer.write({ type: 'data-chat-title', data: title, transient: true });
      }
    },
  });
}

function sanitizeAbortedParts(parts: UIMessage['parts']): UIMessage['parts'] {
  const sanitized: UIMessage['parts'] = [];
  for (const part of parts) {
    if (!isToolUIPart(part)) {
      sanitized.push(part);
      continue;
    }
    switch (part.state) {
      case 'output-available':
      case 'output-error':
      case 'output-denied':
        sanitized.push(part);
        break;
      case 'input-streaming':
        break;
      default: {
        // An output-error part may only carry an approval that was granted.
        const { approval, ...pending } = part;
        sanitized.push({
          ...pending,
          state: 'output-error',
          errorText: 'Cancelled by user',
          ...(approval?.approved === true
            ? { approval: { ...approval, approved: true } }
            : {}),
        });
      }
    }
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
  return error instanceof Error ? 'An error occurred.' : JSON.stringify(error);
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
