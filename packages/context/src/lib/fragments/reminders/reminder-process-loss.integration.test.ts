import type { UIMessage } from 'ai';
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

async function evaluateBoundary(context: ContextEngine): Promise<boolean> {
  const prepareStep = context.createPrepareStep();
  const result = await prepareStep({
    steps: [{ content: [{ type: 'text', text: 'safe boundary' }] }],
    stepNumber: 1,
    model: {},
    instructions: undefined,
    initialInstructions: undefined,
    messages: [],
    initialMessages: [],
    responseMessages: [],
    toolsContext: {},
    runtimeContext: {},
  } as never);
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
