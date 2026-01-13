import { groq } from '@ai-sdk/groq';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import {
  APICallError,
  type LanguageModelMiddleware,
  createUIMessageStream,
  generateId,
  wrapLanguageModel,
} from 'ai';
import { randomUUID } from 'node:crypto';

import { printer } from '@deepagents/agent';

import { ContextEngine, InMemoryContextStore, role, user } from './index.ts';
import { agent } from './lib/agent.ts';
import type { ContextFragment } from './lib/fragments.ts';

type ErrorType =
  | 'no_tools_available'
  | 'tool_not_found'
  | 'parsing_failed'
  | 'unknown';

interface FeedbackContext {
  availableTools?: string[];
  attempt: number;
}

interface ParsedErrorInfo {
  type: ErrorType;
  attemptedTool?: string;
  message: string;
}

class EnrichedModelError extends Error {
  readonly original: unknown;
  readonly parsed: ParsedErrorInfo;
  readonly isRecoverable: boolean;

  constructor(original: unknown, parsed: ParsedErrorInfo) {
    super(parsed.message);
    this.name = 'EnrichedModelError';
    this.original = original;
    this.parsed = parsed;
    this.isRecoverable = parsed.type !== 'unknown';
  }

  static isInstance(error: unknown): error is EnrichedModelError {
    return error instanceof EnrichedModelError;
  }

  createFeedback(context: FeedbackContext): string {
    const { availableTools = [], attempt } = context;
    let feedback: string;

    switch (this.parsed.type) {
      case 'no_tools_available':
        feedback = `CRITICAL: Your previous response failed because you tried to call a tool, but NO TOOLS are available in this context.

You MUST respond with plain text only. Do not attempt any tool calls or function invocations.
Just provide a direct, helpful text response to the user's question.`;
        break;

      case 'tool_not_found':
        if (availableTools.length > 0) {
          feedback = `CRITICAL: Your previous response failed because you tried to call tool '${this.parsed.attemptedTool}' which does not exist.

Available tools: ${availableTools.join(', ')}

You can ONLY use the tools listed above. If none of these tools are appropriate for the task, respond with plain text instead.`;
        } else {
          feedback = `CRITICAL: Your previous response failed because you tried to call tool '${this.parsed.attemptedTool}' which does not exist.

No tools are currently available. You MUST respond with plain text only.`;
        }
        break;

      case 'parsing_failed':
        feedback = `CRITICAL: Your previous response could not be parsed by the system.

Your output format was invalid. Please ensure your response is properly formatted.
If you were attempting to call a tool, ensure the tool call is correctly structured.
Otherwise, respond with plain text only.`;
        break;

      case 'unknown':
      default:
        feedback = `CRITICAL: Your previous response failed with an API error.

Error: ${this.parsed.message}

Please adjust your response to avoid this error. If you were trying to use a tool, it may not be available.`;
        break;
    }

    return `<system_error attempt="${attempt}">\n${feedback}\n</system_error>`;
  }
}

function isInvalidRequestError(
  error: unknown,
): error is APICallError | { message: string; type: string } {
  if (APICallError.isInstance(error)) {
    const data = error.data as { error?: { type?: string } } | undefined;
    return data?.error?.type === 'invalid_request_error';
  }

  if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    (error as Record<string, unknown>).type === 'invalid_request_error'
  ) {
    return true;
  }

  return false;
}

function getErrorMessage(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const data = error.data as { error?: { message?: string } } | undefined;
    return data?.error?.message || error.message;
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return (error as { message: string }).message;
  }

  return String(error);
}

function parseError(error: unknown): ParsedErrorInfo {
  const message = getErrorMessage(error);

  if (message.includes('Tool choice is none')) {
    return { type: 'no_tools_available', message };
  }

  const toolNotFoundMatch = message.match(
    /attempted to call tool '([^']+)' which was not in request\.tools/,
  );
  if (toolNotFoundMatch) {
    return {
      type: 'tool_not_found',
      attemptedTool: toolNotFoundMatch[1],
      message,
    };
  }

  if (message.includes('Parsing failed')) {
    return { type: 'parsing_failed', message };
  }

  return { type: 'unknown', message };
}

const errorRecoveryMiddleware: LanguageModelMiddleware = {
  wrapStream: async ({ doStream }) => {
    const result = await doStream();

    const transformedStream = result.stream.pipeThrough(
      new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>(
        {
          transform(chunk, controller) {
            if (chunk.type === 'error' && isInvalidRequestError(chunk.error)) {
              const parsed = parseError(chunk.error);
              controller.enqueue({
                type: 'error',
                error: new EnrichedModelError(chunk.error, parsed),
              });
            } else {
              controller.enqueue(chunk);
            }
          },
        },
      ),
    );

    return { ...result, stream: transformedStream };
  },
};

type Agent = ReturnType<typeof agent>;

interface StreamWithRecoveryOptions {
  agent: Agent;
  context: ContextEngine;
  availableTools?: string[];
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

function streamWithRecovery(options: StreamWithRecoveryOptions) {
  const {
    agent: agentInstance,
    context,
    availableTools = [],
    maxRetries = 3,
    abortSignal,
  } = options;

  return createUIMessageStream({
    generateId,
    async execute({ writer }) {
      let attempt = 0;

      while (attempt < maxRetries) {
        attempt++;
        const stream = await agentInstance.stream({}, { abortSignal });
        let errorEncountered = false;

        for await (const part of stream.fullStream) {
          if (part.type === 'error') {
            const error = part.error;

            if (EnrichedModelError.isInstance(error) && error.isRecoverable) {
              context.set(
                user(error.createFeedback({ availableTools, attempt })),
              );
              errorEncountered = true;
              break;
            }

            writer.write({ type: 'error', errorText: getErrorMessage(error) });
          } else if (part.type === 'text-delta') {
            writer.write({ type: 'text-delta', delta: part.text, id: part.id });
          } else if (part.type === 'reasoning-delta') {
            writer.write({
              type: 'reasoning-delta',
              delta: part.text,
              id: part.id,
            });
          } else {
            writer.write(part as never);
          }
        }

        if (!errorEncountered) {
          writer.write({ type: 'finish' });
          return;
        }

        if (attempt >= maxRetries) {
          throw new Error(`Max retries (${maxRetries}) exceeded`);
        }
      }
    },
    onError: (error) => {
      return `Stream failed: ${error instanceof Error ? error.message : String(error)}`;
    },
  });
}

function engine(...fragments: ContextFragment[]) {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: randomUUID(),
  });
  context.set(...fragments);
  return context;
}

const context = engine(
  role('You are a helpful assistant. Use the tell_joke tool to tell a joke.'),
  user('Hello! Tell me a joke please.'),
);

const testAgent = agent({
  name: 'joke_agent',
  context,
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: errorRecoveryMiddleware,
  }),
});

const stream = streamWithRecovery({
  agent: testAgent,
  context,
  maxRetries: 3,
});

await printer.readableStream(stream, {
  reasoning: false,
  wrapInTags: false,
  text: true,
});
