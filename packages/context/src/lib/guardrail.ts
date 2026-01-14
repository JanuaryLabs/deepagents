/**
 * Guardrail system for real-time stream interception and self-correction.
 *
 * Guardrails inspect streaming parts and can either:
 * - `pass(part)`: Allow the part through (optionally modified)
 * - `fail(feedback)`: Abort the stream and retry with self-correction feedback
 *
 * When a guardrail fails, the accumulated text is combined with the feedback
 * to create a "self-correction" that appears as if the agent caught itself.
 *
 * @example
 * ```typescript
 * const safetyGuardrail: Guardrail = {
 *   id: 'safety',
 *   name: 'Safety Filter',
 *   handle: (part, context) => {
 *     if (part.type === 'text-delta' && part.delta.includes('unsafe')) {
 *       return fail('I should not provide this information. Let me help differently.');
 *     }
 *     if (part.type === 'error' && context.availableTools.length > 0) {
 *       return fail(`Try using: ${context.availableTools.join(', ')}`);
 *     }
 *     return pass(part);
 *   },
 * };
 *
 * const agent = agent({
 *   name: 'safe_assistant',
 *   context,
 *   model,
 *   guardrails: [safetyGuardrail],
 * });
 * ```
 */
import type { InferUIMessageChunk, UIDataTypes, UIMessage } from 'ai';

/**
 * Type alias for stream parts from the AI SDK's UI message stream.
 * This is the full chunk type that includes text-delta, error, reasoning-delta, etc.
 */
export type StreamPart = InferUIMessageChunk<
  UIMessage<unknown, UIDataTypes, Record<string, never>>
>;

/**
 * Result of a guardrail check.
 * - `pass`: The part is allowed through (optionally modified)
 * - `fail`: The stream should abort and retry with feedback
 */
export type GuardrailResult =
  | { type: 'pass'; part: StreamPart }
  | { type: 'fail'; feedback: string };

/**
 * Context passed to guardrails during stream processing.
 * Provides information about the agent's capabilities.
 */
export interface GuardrailContext {
  /** Names of tools available to the agent */
  availableTools: string[];
}

/**
 * A guardrail that inspects streaming parts.
 */
export interface Guardrail {
  /** Unique identifier for this guardrail */
  id: string;
  /** Human-readable name for logging/debugging */
  name: string;
  /**
   * Handle a stream part.
   *
   * @param part - The full stream part to inspect (text-delta, error, etc.)
   * @param context - Context with agent capabilities (available tools, etc.)
   * @returns Either `pass(part)` to allow or `fail(feedback)` to abort and retry
   */
  handle: (part: StreamPart, context: GuardrailContext) => GuardrailResult;
}

/**
 * Configuration for guardrail behavior.
 */
export interface GuardrailConfig {
  /** Maximum number of retry attempts when guardrails fail (default: 3) */
  maxRetries?: number;
}

/**
 * Allow a part to pass through the guardrail.
 *
 * @param part - The part to pass (can be modified from original)
 * @returns A pass result
 *
 * @example
 * ```typescript
 * handle: (part) => {
 *   // Pass through unchanged
 *   return pass(part);
 *
 *   // Or modify text-delta before passing
 *   if (part.type === 'text-delta') {
 *     return pass({ ...part, delta: part.delta.replace('bad', 'good') });
 *   }
 *   return pass(part);
 * }
 * ```
 */
export function pass(part: StreamPart): GuardrailResult {
  return { type: 'pass', part };
}

/**
 * Fail the guardrail check and trigger a retry with feedback.
 *
 * The feedback will be appended to the accumulated assistant text,
 * making it appear as if the agent "caught itself" and self-corrected.
 *
 * @param feedback - The self-correction feedback to append
 * @returns A fail result
 *
 * @example
 * ```typescript
 * handle: (part) => {
 *   if (part.type === 'text-delta' && part.delta.includes('hack')) {
 *     return fail('I should not provide hacking instructions. Let me suggest ethical alternatives.');
 *   }
 *   if (part.type === 'error') {
 *     return fail('An error occurred. Let me try a different approach.');
 *   }
 *   return pass(part);
 * }
 * ```
 */
export function fail(feedback: string): GuardrailResult {
  return { type: 'fail', feedback };
}

/**
 * Run a part through a chain of guardrails sequentially.
 *
 * @param part - The stream part to check
 * @param guardrails - Array of guardrails to run in order
 * @param context - Context with agent capabilities (available tools, etc.)
 * @returns The final result after all guardrails pass, or the first failure
 */
export function runGuardrailChain(
  part: StreamPart,
  guardrails: Guardrail[],
  context: GuardrailContext,
): GuardrailResult {
  let currentPart = part;

  for (const guardrail of guardrails) {
    const result = guardrail.handle(currentPart, context);

    if (result.type === 'fail') {
      return result;
    }

    // Pass the (possibly modified) part to the next guardrail
    currentPart = result.part;
  }

  return pass(currentPart);
}
