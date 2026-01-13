import { groq } from '@ai-sdk/groq';
import { APICallError, createUIMessageStream, generateId } from 'ai';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import { printer } from '@deepagents/agent';

import { ContextEngine, InMemoryContextStore, role, user } from './index.ts';
import { agent } from './lib/agent.ts';
import type { ContextFragment } from './lib/fragments.ts';

function engine(...fragments: ContextFragment[]) {
  const context = new ContextEngine({
    store: new InMemoryContextStore(),
    chatId: randomUUID(),
  });
  context.set(...fragments);
  return context;
}

// =============================================================================
// Error Detection and Feedback
// =============================================================================

/**
 * Checks if an error is an invalid_request_error from the API.
 * These are model behavior errors (like calling non-existent tools)
 * that the AI SDK doesn't retry by default because they're not transient.
 *
 * The error can come in two forms:
 * 1. As an APICallError instance (when thrown)
 * 2. As a plain object in stream error parts (when streamed)
 */
function isInvalidRequestError(
  error: unknown,
): error is APICallError | { message: string; type: string } {
  // Check if it's an APICallError instance
  if (APICallError.isInstance(error)) {
    const data = error.data as { error?: { type?: string } } | undefined;
    return data?.error?.type === 'invalid_request_error';
  }

  // Check if it's a plain error object from stream
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

/**
 * Extracts the error message from various error formats.
 */
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

// =============================================================================
// Smart Error Parsing
// =============================================================================

/**
 * Parsed error information extracted from invalid_request_error messages.
 */
interface ParsedError {
  /** The type of error detected */
  type: 'no_tools_available' | 'tool_not_found' | 'parsing_failed' | 'unknown';
  /** The tool name the model tried to call (for tool_not_found) */
  attemptedTool?: string;
  /** The original error message */
  message: string;
}

/**
 * Parses an invalid_request_error to extract structured information.
 * This allows us to provide more specific feedback to the model.
 *
 * Known error patterns:
 * 1. "Tool choice is none, but model called a tool" - No tools available
 * 2. "tool call validation failed: attempted to call tool 'X' which was not in request.tools" - Specific tool not found
 * 3. "Parsing failed. The model generated output that could not be parsed" - Malformed output
 */
function parseInvalidRequestError(error: unknown): ParsedError {
  const message = getErrorMessage(error);

  // Pattern 1: No tools available (toolChoice: none)
  if (message.includes('Tool choice is none')) {
    return {
      type: 'no_tools_available',
      message,
    };
  }

  // Pattern 2: Tool not in available list
  // Example: "tool call validation failed: attempted to call tool 'read' which was not in request.tools"
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

  // Pattern 3: Parsing failed (malformed output)
  if (message.includes('Parsing failed')) {
    return {
      type: 'parsing_failed',
      message,
    };
  }

  // Unknown pattern - fallback
  return {
    type: 'unknown',
    message,
  };
}

/**
 * Creates a context-aware user message containing error feedback for the model.
 * The feedback is tailored based on the specific error type to help the model
 * understand exactly what went wrong and how to fix it.
 */
function createErrorFeedbackMessage(
  error: unknown,
  attemptNumber: number,
  availableTools?: string[],
) {
  const parsed = parseInvalidRequestError(error);

  let feedback: string;

  switch (parsed.type) {
    case 'no_tools_available':
      feedback = `CRITICAL: Your previous response failed because you tried to call a tool, but NO TOOLS are available in this context.

You MUST respond with plain text only. Do not attempt any tool calls or function invocations.
Just provide a direct, helpful text response to the user's question.`;
      break;

    case 'tool_not_found':
      if (availableTools && availableTools.length > 0) {
        feedback = `CRITICAL: Your previous response failed because you tried to call tool '${parsed.attemptedTool}' which does not exist.

Available tools: ${availableTools.join(', ')}

You can ONLY use the tools listed above. If none of these tools are appropriate for the task, respond with plain text instead.`;
      } else {
        feedback = `CRITICAL: Your previous response failed because you tried to call tool '${parsed.attemptedTool}' which does not exist.

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

Error: ${parsed.message}

Please adjust your response to avoid this error. If you were trying to use a tool, it may not be available.`;
      break;
  }

  return {
    role: 'user',
    content: `<system_error attempt="${attemptNumber}">
${feedback}
</system_error>`,
  };
}

// =============================================================================
// Stream with Model Error Retry
// =============================================================================

// Type for the agent returned by the agent() function
type Agent = ReturnType<typeof agent>;

interface StreamWithRetryOptions {
  /** The agent instance to use for streaming */
  agent: Agent;
  /** The context engine (needed to add error feedback messages) */
  context: ContextEngine;
  /** Name for logging purposes */
  name: string;
  /** Available tool names for error feedback */
  availableTools?: string[];
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

/**
 * Streams text from an agent with automatic retry on invalid_request_error.
 *
 * Uses `createUIMessageStream` to return a proper ReadableStream that's compatible
 * with the AI SDK's stream infrastructure.
 *
 * When the model makes an error (like calling a non-existent tool), this function:
 * 1. Catches the error from the stream
 * 2. Adds the error as feedback to the context using context.set()
 * 3. Retries by calling agent.stream() again
 *
 * This is different from the AI SDK's built-in retry which only retries
 * on network/transient errors. Model behavior errors need context feedback
 * to be corrected.
 *
 * @returns A ReadableStream that can be consumed or converted to UI messages
 */
function streamWithRetry(options: StreamWithRetryOptions) {
  const {
    agent: agentInstance,
    context,
    name,
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

        // Call agent.stream() - it internally resolves context and calls streamText
        const stream = await agentInstance.stream(
          {}, // contextVariables
          { abortSignal },
        );

        let errorEncountered = false;

        // Iterate through the stream to detect errors
        for await (const part of stream.fullStream) {
          if (part.type === 'error') {
            const error = part.error;
            if (isInvalidRequestError(error)) {
              console.log(
                chalk.yellow(
                  `[${name}] Attempt ${attempt}/${maxRetries}: Model error detected, adding feedback and retrying...`,
                ),
              );
              console.log(chalk.dim(`  Error: ${getErrorMessage(error)}`));

              // Add error feedback to the context for the next retry
              const feedbackMessage = createErrorFeedbackMessage(
                error,
                attempt,
                availableTools,
              );
              context.set(user(feedbackMessage.content as string));

              errorEncountered = true;
              break; // Exit inner loop to retry
            }
            // For other errors, transform to UIMessageChunk format
            writer.write({ type: 'error', errorText: getErrorMessage(error) });
          } else if (part.type === 'text-delta') {
            // Transform fullStream 'text' to UIMessageChunk 'delta'
            writer.write({
              type: 'text-delta',
              delta: part.text,
              id: part.id,
            });
          } else if (part.type === 'reasoning-delta') {
            // Transform fullStream reasoning to UIMessageChunk format
            writer.write({
              type: 'reasoning-delta',
              delta: part.text,
              id: part.id,
            });
          } else {
            // Pass through other parts (start, end, etc.)
            writer.write(part as never);
          }
        }

        // If we completed without error, we're done
        if (!errorEncountered) {
          writer.write({ type: 'finish' });
          return;
        }

        // Check if we've exceeded max retries
        if (attempt >= maxRetries) {
          console.error(
            chalk.red(
              `[${name}] Max retries (${maxRetries}) exceeded. Throwing error.`,
            ),
          );
          throw new Error(`[${name}] Max retries (${maxRetries}) exceeded`);
        }

        // Otherwise, continue to next attempt
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return `Stream failed: ${message}`;
    },
  });
}

// =============================================================================
// Test
// =============================================================================

console.log(
  chalk.bold.blue('\n=== Testing Model Error Retry with Agent.stream() ===\n'),
);

// Scenario: Model is told to use a tool that doesn't exist (no tools provided)
const context = engine(
  role('You are a helpful assistant. Use the tell_joke tool to tell a joke.'),
  user('Hello! Tell me a joke please.'),
);

// Create an agent instance
const testAgent = agent({
  name: 'greeting_agent',
  context,
  model: groq('openai/gpt-oss-20b'),
  // No tools provided - this will cause the model to fail when it tries to call tell_joke
});

console.log(chalk.cyan('Test scenario:'));
console.log(chalk.dim('  - System prompt tells model to use "tell_joke" tool'));
console.log(chalk.dim('  - No tools are actually provided to the agent'));
console.log(
  chalk.dim(
    '  - Model will try to call the tool, causing invalid_request_error',
  ),
);
console.log(
  chalk.dim(
    '  - Retry mechanism adds error feedback to context via context.set()',
  ),
);
console.log(
  chalk.dim('  - Agent.stream() is called again with updated context\n'),
);

try {
  const stream = streamWithRetry({
    agent: testAgent,
    context,
    name: 'greeting_agent',
    maxRetries: 3,
  });

  // Use printer.readableStream to consume the stream
  await printer.readableStream(stream, {
    reasoning: false, // Don't print reasoning (too verbose)
    wrapInTags: false, // Don't wrap output in XML tags
    text: true, // Print text deltas
  });

  console.log(chalk.green('\n\n✓ Stream completed successfully'));
} catch (error) {
  console.error(chalk.red('\n✗ Stream failed:'), error);
}
