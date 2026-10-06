import type { StepResult, ToolSet, UIMessage } from 'ai';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  type WhenPredicate,
  everyNToolCalls,
  once,
  reminder,
  user,
} from '@deepagents/context';

const chatId = 'reminder-process-loss';
const userId = 'user-1';

function assistantWithCompletedTools(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: Array.from({ length: 5 }, (_, index) => ({
      type: 'tool-noop' as const,
      toolCallId: `call-${index}`,
      state: 'output-available' as const,
      input: {},
      output: { ok: true },
    })),
  };
}

function review(when: WhenPredicate) {
  return reminder('REVIEW', { when, target: 'steer' });
}

async function seed(
  store: InMemoryContextStore,
  when: WhenPredicate,
): Promise<{ context: ContextEngine; assistant: UIMessage }> {
  const context = new ContextEngine({ store, chatId, userId }).set(
    review(when),
  );
  const assistantId = await context.continue(user('start'));
  const assistant = assistantWithCompletedTools(assistantId);
  await context.writeAssistantSegment(assistant);
  return { context, assistant };
}

/** A completed text step: the safe boundary a steer reminder waits for. */
const safeBoundaryStep: StepResult<ToolSet> = {
  callId: 'call-0',
  stepNumber: 0,
  model: { provider: 'mock', modelId: 'mock-model' },
  toolsContext: {},
  runtimeContext: {},
  content: [{ type: 'text', text: 'safe boundary' }],
  text: 'safe boundary',
  reasoning: [],
  reasoningText: undefined,
  files: [],
  sources: [],
  toolCalls: [],
  staticToolCalls: [],
  dynamicToolCalls: [],
  toolResults: [],
  staticToolResults: [],
  dynamicToolResults: [],
  finishReason: 'stop',
  rawFinishReason: undefined,
  usage: {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  },
  performance: {
    effectiveOutputTokensPerSecond: 0,
    outputTokensPerSecond: undefined,
    inputTokensPerSecond: undefined,
    effectiveTotalTokensPerSecond: 0,
    stepTimeMs: 0,
    responseTimeMs: 0,
    toolExecutionMs: {},
    timeToFirstOutputMs: undefined,
  },
  warnings: undefined,
  request: {},
  response: {
    messages: [],
    id: 'response-0',
    timestamp: new Date(0),
    modelId: 'mock-model',
  },
  providerMetadata: undefined,
};

async function evaluateBoundary(context: ContextEngine): Promise<boolean> {
  const prepareStep = context.createPrepareStep();
  const result = await prepareStep({
    steps: [safeBoundaryStep],
    stepNumber: 1,
    model: 'mock-model',
    instructions: undefined,
    initialInstructions: undefined,
    messages: [],
    initialMessages: [],
    responseMessages: [],
    toolsContext: {},
    runtimeContext: {},
  });
  return JSON.stringify(result)?.includes('REVIEW') ?? false;
}

describe('reminder process-loss durability', () => {
  it('does not redeliver an everyNToolCalls boundary after engine reconstruction', async () => {
    const store = new InMemoryContextStore();
    const first = await seed(store, everyNToolCalls(5));
    assert.equal(await evaluateBoundary(first.context), true);

    const restarted = new ContextEngine({ store, chatId, userId }).set(
      review(everyNToolCalls(5)),
    );

    assert.equal(
      await evaluateBoundary(restarted),
      false,
      'a boundary already returned to the model must be durable before process loss',
    );
  });

  it('does not redeliver a once-gated boundary after engine reconstruction', async () => {
    const store = new InMemoryContextStore();
    const first = await seed(store, once('process-loss-review'));
    assert.equal(await evaluateBoundary(first.context), true);

    const restarted = new ContextEngine({ store, chatId, userId }).set(
      review(once('process-loss-review')),
    );

    assert.equal(
      await evaluateBoundary(restarted),
      false,
      'once(id) must be committed before its reminder can reach the model',
    );
  });
});
