/**
 * Example: Error Recovery with Guardrails
 *
 * This demonstrates how guardrails can intercept API errors and trigger
 * self-correction retries.
 *
 * Scenario:
 * - System prompt tells the model to use "tell_joke" tool
 * - No tools are actually provided to the agent
 * - Model tries to call the tool → API returns invalid_request_error
 * - Error guardrail catches it and provides feedback
 * - Agent retries and responds with plain text
 *
 * Run with: node packages/context/src/example-error-recovery.ts
 */
import { groq } from '@ai-sdk/groq';
import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

import { printer } from '@deepagents/agent';

import {
  ContextEngine,
  type Guardrail,
  InMemoryContextStore,
  fail,
  pass,
  role,
  user,
} from './index.ts';
import { agent } from './lib/agent.ts';
import type { ContextFragment } from './lib/fragments.ts';

// =============================================================================
// Helper to create a context engine
// =============================================================================

function engine(...fragments: ContextFragment[]) {
  const context = new ContextEngine({
    userId: 'demo-user',
    store: new InMemoryContextStore(),
    chatId: randomUUID(),
  });
  context.set(...fragments);
  return context;
}

// =============================================================================
// Error Recovery Guardrail
// =============================================================================

/**
 * Guardrail that intercepts error parts and triggers retry with feedback.
 *
 * This catches errors like:
 * - "Tool choice is none, but model called a tool"
 * - "attempted to call tool 'X' which was not in request.tools"
 * - Parsing failures
 *
 * Uses context.availableTools to tell the model what tools ARE available.
 */
const errorRecoveryGuardrail: Guardrail = {
  id: 'error-recovery',
  name: 'API Error Recovery',
  handle: (part, context) => {
    // Only handle error parts
    if (part.type !== 'error') {
      return pass(part);
    }

    const errorText = part.errorText || '';
    console.log(chalk.red(`\n[Guardrail] Caught error: ${errorText}\n`));

    // Pattern: No tools available but model tried to call one
    if (errorText.includes('Tool choice is none')) {
      if (context.availableTools.length > 0) {
        return fail(
          `I tried to call a tool that doesn't exist. Available tools: ${context.availableTools.join(', ')}. Let me use one of these instead.`,
        );
      }
      return fail(
        'I tried to call a tool, but no tools are available. Let me respond with plain text instead.',
      );
    }

    // Pattern: Tool not found
    if (
      errorText.includes('not in request.tools') ||
      (errorText.includes('tool') && errorText.includes('not found'))
    ) {
      const toolMatch = errorText.match(/tool '([^']+)'/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      if (context.availableTools.length > 0) {
        return fail(
          `I tried to call "${toolName}" but it doesn't exist. Available tools: ${context.availableTools.join(', ')}. Let me use one of these instead.`,
        );
      }
      return fail(
        `I tried to call "${toolName}" but no tools are available. Let me respond with plain text instead.`,
      );
    }

    // Pattern: Parsing failed
    if (errorText.includes('Parsing failed')) {
      return fail(
        'My response format was invalid. Let me try again with a properly formatted response.',
      );
    }

    // Unknown error - still try to recover
    return fail(
      `An error occurred: ${errorText.slice(0, 100)}. Let me try a different approach.`,
    );
  },
};

// =============================================================================
// Content Safety Guardrail (bonus - showing both types work together)
// =============================================================================

const safetyGuardrail: Guardrail = {
  id: 'safety',
  name: 'Safety Filter',
  handle: (part, _context) => {
    if (part.type === 'text-delta') {
      const delta = (part as { delta: string }).delta;
      if (delta.toLowerCase().includes('hack')) {
        return fail(
          'I should not provide hacking instructions. Let me suggest ethical alternatives instead.',
        );
      }
    }
    return pass(part);
  },
};

// =============================================================================
// Test
// =============================================================================

console.log(
  chalk.bold.blue('\n=== Testing Error Recovery with Guardrails ===\n'),
);

// Scenario: Model is told to use a tool that doesn't exist (no tools provided)
const context = engine(
  role('You are a helpful assistant. Use the tell_joke tool to tell a joke.'),
  user('Hello! Tell me a joke please.'),
);

// Create an agent with error recovery guardrail
// Note: No tools are provided, so the model will fail when it tries to call tell_joke
const testAgent = agent({
  name: 'joke_agent',
  context,
  model: groq('openai/gpt-oss-20b'),
  guardrails: [errorRecoveryGuardrail, safetyGuardrail],
  maxGuardrailRetries: 3,
});

console.log(chalk.cyan('Test scenario:'));
console.log(chalk.dim('  - System prompt tells model to use "tell_joke" tool'));
console.log(chalk.dim('  - No tools are actually provided to the agent'));
console.log(chalk.dim('  - Model will try to call the tool → API error'));
console.log(
  chalk.dim('  - Error guardrail catches it and triggers retry with feedback'),
);
console.log(
  chalk.dim('  - Agent retries and should respond with plain text\n'),
);

try {
  const stream = await testAgent.stream({});

  // Consume via toUIMessageStream which applies guardrails
  await printer.readableStream(stream.toUIMessageStream(), {
    reasoning: true,
    wrapInTags: true,
    text: true,
  });

  console.log(chalk.green('\n\n✓ Stream completed successfully'));
} catch (error) {
  console.error(chalk.red('\n✗ Stream failed:'), error);
}
