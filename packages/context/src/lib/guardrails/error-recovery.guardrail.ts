/**
 * Error Recovery Guardrail
 *
 * Intercepts API-level errors (like tool validation failures) and triggers
 * self-correction retries. This is essential for models like gpt-oss-20b
 * that may hallucinate tools that don't exist.
 *
 * Catches errors like:
 * - "Tool choice is none, but model called a tool"
 * - "attempted to call tool 'X' which was not in request.tools"
 * - "Failed to parse tool call arguments as JSON" (malformed JSON)
 * - Parsing failures
 *
 * @example
 * ```typescript
 * const myAgent = agent({
 *   name: 'my_agent',
 *   model: groq('openai/gpt-oss-20b'),
 *   tools: { bash, sql },
 *   guardrails: [errorRecoveryGuardrail],
 *   maxGuardrailRetries: 3,
 * });
 * ```
 */
import chalk from 'chalk';

import type { Guardrail } from '../guardrail.ts';
import { fail, pass } from '../guardrail.ts';

export const errorRecoveryGuardrail: Guardrail = {
  id: 'error-recovery',
  name: 'API Error Recovery',
  handle: (part, context) => {
    // Only handle error parts
    if (part.type !== 'error') {
      return pass(part);
    }

    const errorText = part.errorText || '';
    const prefix = chalk.bold.magenta('[ErrorRecovery]');

    console.log(
      `${prefix} ${chalk.red('Caught error:')} ${chalk.dim(errorText.slice(0, 150))}`,
    );

    // Helper to log and return fail
    const logAndFail = (pattern: string, feedback: string) => {
      console.log(
        `${prefix} ${chalk.yellow('Pattern:')} ${chalk.cyan(pattern)}`,
      );
      console.log(
        `${prefix} ${chalk.green('Feedback:')} ${chalk.dim(feedback.slice(0, 80))}...`,
      );
      return fail(feedback);
    };

    // Pattern: No tools available but model tried to call one
    if (errorText.includes('Tool choice is none')) {
      if (context.availableTools.length > 0) {
        return logAndFail(
          'Tool choice is none',
          `I tried to call a tool that doesn't exist. Available tools: ${context.availableTools.join(', ')}. Let me use one of these instead.`,
        );
      }
      return logAndFail(
        'Tool choice is none (no tools)',
        'I tried to call a tool, but no tools are available. Let me respond with plain text instead.',
      );
    }

    // Pattern: Tool not found in request.tools
    if (
      errorText.includes('not in request.tools') ||
      (errorText.includes('tool') && errorText.includes('not found'))
    ) {
      const toolMatch = errorText.match(/tool '([^']+)'/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      if (context.availableTools.length > 0) {
        return logAndFail(
          `Unregistered tool: ${toolName}`,
          `I tried to call "${toolName}" but it doesn't exist. Available tools: ${context.availableTools.join(', ')}. Let me use one of these instead.`,
        );
      }
      return logAndFail(
        `Unregistered tool: ${toolName} (no tools)`,
        `I tried to call "${toolName}" but no tools are available. Let me respond with plain text instead.`,
      );
    }

    // Pattern: Failed to parse tool arguments as JSON
    if (
      errorText.includes('Failed to parse tool call arguments') ||
      errorText.includes('parse tool call') ||
      errorText.includes('invalid JSON')
    ) {
      return logAndFail(
        'Malformed JSON arguments',
        'I generated malformed JSON for the tool arguments. Let me format my tool call properly with valid JSON.',
      );
    }

    // Pattern: Parsing failed (generic)
    if (errorText.includes('Parsing failed')) {
      return logAndFail(
        'Parsing failed',
        'My response format was invalid. Let me try again with a properly formatted response.',
      );
    }
    console.dir({ part }, { depth: null });
    // Unknown error - still try to recover
    return logAndFail(
      'Unknown error',
      `An error occurred: ${errorText}. Let me try a different approach.`,
    );
  },
};
