import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import {
  type UIMessage,
  convertToModelMessages,
  generateId,
  isToolUIPart,
  simulateReadableStream,
  tool,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { z } from 'zod';

import {
  type AgentSandbox,
  ContextEngine,
  type Guardrail,
  InMemoryContextStore,
  agent,
  and,
  chat,
  createBashTool,
  createVirtualSandbox,
  elapsedExceeds,
  everyNTurns,
  fail,
  isSyntheticReminderMessage,
  once,
  or,
  pass,
  plan,
  reminder,
  stripReminders,
  toolCallCount,
  toolOutput,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec = { tool: string } | { text: string };

/**
 * A V4 mock that scripts one model step per spec: `{tool}` emits a tool call and
 * keeps the loop going; `{text}` emits text and stops. Tests inspect the mock's
 * built-in call history when they need the prompt for a step.
 */
function scriptedModel(steps: StepSpec[]) {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const call = model.doStreamCalls.length;
      const spec = steps[Math.min(call - 1, steps.length - 1)];
      const id = `s${call}`;
      const chunks: LanguageModelV4StreamPart[] = [];
      if ('text' in spec) {
        chunks.push(
          { type: 'text-start', id },
          { type: 'text-delta', id, delta: spec.text },
          { type: 'text-end', id },
        );
      }
      if ('tool' in spec) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `c${call}`,
          toolName: spec.tool,
          input: '{}',
        });
      }
      chunks.push({
        type: 'finish',
        finishReason: {
          unified: 'tool' in spec ? 'tool-calls' : 'stop',
          raw: '',
        },
        usage: testUsage,
      });
      return {
        stream: simulateReadableStream({ chunks }),
      };
    },
  });
  return model;
}

const noopTool = tool({
  description: 'A no-op tool used to drive multi-step loops.',
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

async function makeAgent(
  context: ContextEngine,
  model: MockLanguageModelV4,
  name: string,
  suppliedSandbox?: AgentSandbox,
) {
  const sandbox =
    suppliedSandbox ??
    (await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    }));
  return agent({ sandbox, name, context, model, tools: { noop: noopTool } });
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

async function storedEntries(store: InMemoryContextStore, chatId: string) {
  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId, 'expected a branch head');
  return store.getMessageChain(branch.headMessageId);
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function rolesOf(modelMessages: { role: string }[]): string[] {
  return modelMessages.map((m) => m.role);
}

function planFile(tasks: unknown[]) {
  return JSON.stringify({
    revision: 3,
    objective: {
      text: 'Ship sandbox-backed plan recitation',
      basis: 'explicit_requirement',
      source: 'user request',
    },
    successCriteria: [
      {
        id: 'SC1',
        text: 'The latest valid plan appears in the steer reminder',
        basis: 'inference',
        source: 'recitation.md',
        evidence: [],
      },
    ],
    constraints: [
      {
        text: 'Use the existing steer reminder',
        basis: 'discovered_constraint',
        source: 'packages/context',
      },
    ],
    assumptions: [],
    tasks,
  });
}

describe('steer reminders integration (chat flow)', () => {
  it('recites plan review at the five-tool persisted-history cadence', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'plan-review',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'done' },
    ]);
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.sandbox.writeFiles([
      {
        path: plan.path,
        content: planFile([
          {
            id: 'T1',
            title: 'Establish the review primitive',
            status: 'completed',
            blockedBy: [],
            evidence: [
              {
                summary: 'Phase 1 integration test passes',
                source: 'steer-reminders.integration.test.ts',
              },
            ],
          },
          {
            id: 'T2',
            title: 'Load the sandbox plan',
            status: 'pending',
            blockedBy: ['T1'],
            evidence: [],
          },
          {
            id: 'T3',
            title: 'Complete end-to-end integration',
            status: 'pending',
            blockedBy: ['T2'],
            evidence: [],
          },
        ]),
      },
    ]);
    const chatAgent = await makeAgent(context, model, 'plan-review', sandbox);

    context.set(
      plan.review({
        when: toolCallCount(() => true, { gte: 5 }),
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const reviewQuestion =
      'Is the current plan still valid given the latest evidence?';
    const prompts = model.doStreamCalls.map((call) =>
      JSON.stringify(call.prompt),
    );
    assert.ok(
      prompts.slice(0, 6).every((prompt) => !prompt.includes(reviewQuestion)),
      'plan review must not fire before five tools reach persisted history',
    );
    assert.strictEqual(
      prompts.findIndex((prompt) => prompt.includes(reviewQuestion)),
      6,
      `the next safe boundary must see the plan review; observed ${prompts.length} model calls`,
    );

    const syntheticReviews = (await storedEntries(store, 'plan-review'))
      .filter(
        (entry) =>
          entry.name === 'user' &&
          isSyntheticReminderMessage(entry.data as UIMessage),
      )
      .map((entry) => textOf(entry.data as UIMessage));
    assert.strictEqual(syntheticReviews.length, 1);
    assert.ok(syntheticReviews[0].includes(reviewQuestion));
    assert.ok(
      syntheticReviews[0].includes(
        'Objective: Ship sandbox-backed plan recitation',
      ),
    );
    assert.ok(
      syntheticReviews[0].includes('T2: Load the sandbox plan; blocks T3'),
    );
    assert.ok(
      syntheticReviews[0].includes(
        'T3: Complete end-to-end integration; waiting for T2',
      ),
    );
    assert.ok(
      syntheticReviews[0].includes(
        'Before claiming completion, verify the success criteria against evidence.',
      ),
    );
  });

  it('recites an actionable validation failure for a directly edited cyclic plan', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'invalid-plan-review',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'done' },
    ]);
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.sandbox.writeFiles([
      {
        path: plan.path,
        content: planFile([
          {
            id: 'T1',
            title: 'First cyclic task',
            status: 'pending',
            blockedBy: ['T2'],
            evidence: [],
          },
          {
            id: 'T2',
            title: 'Second cyclic task',
            status: 'pending',
            blockedBy: ['T1'],
            evidence: [],
          },
        ]),
      },
    ]);
    const chatAgent = await makeAgent(
      context,
      model,
      'invalid-plan-review',
      sandbox,
    );

    context.set(
      plan.review({
        when: toolCallCount(() => true, { gte: 1 }),
      }),
    );

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const prompts = model.doStreamCalls.map((call) =>
      JSON.stringify(call.prompt),
    );
    assert.ok(
      prompts.some((prompt) =>
        prompt.includes('dependency cycle: T1 -> T2 -> T1'),
      ),
      `expected a persisted cycle validation reminder; got ${JSON.stringify(prompts)}`,
    );
  });

  it('fires mid-loop: stored chain splits assistant and matches the model prompt (parity)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'mid', userId: 'u1' });
    const model = scriptedModel([
      { tool: 'noop' },
      { text: 'post-steer answer' },
    ]);
    const chatAgent = await makeAgent(context, model, 'mid');

    context.set(reminder('RECAP', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('run the task'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'mid');
    assert.deepStrictEqual(
      chain.map((e) => e.name),
      ['user', 'assistant', 'user', 'assistant'],
      `expected user → assistant(pre) → user(synth) → assistant(post); got ${JSON.stringify(chain.map((e) => e.name))}`,
    );

    const synth = chain[2].data as UIMessage;
    assert.ok(
      isSyntheticReminderMessage(synth),
      'middle user must be synthetic steer',
    );
    assert.ok(
      textOf(synth).includes('<system-reminder>RECAP</system-reminder>'),
    );

    const preSteer = chain[1].data as UIMessage;
    assert.ok(
      preSteer.parts.length > 0,
      'pre-steer assistant must hold step-0 content',
    );
    assert.ok(
      textOf(chain[3].data as UIMessage).includes('post-steer answer'),
      'post-steer assistant must hold the final step content',
    );

    // Parity: the model's last prompt is exactly the stored chain minus the
    // assistant turn it then generated. We drop the system message (added by the
    // agent, not stored as a chain node) and pre-existing data-* UI parts (e.g.
    // the chat-title data part, unrelated to steer) which are not part of the
    // model conversation.
    const stripData = (m: UIMessage): UIMessage => ({
      ...m,
      parts: m.parts.filter((p) => !p.type.startsWith('data-')),
    });
    const storedUi = chain
      .map((e) => stripData(e.data as UIMessage))
      .filter((m) => !(m.role === 'assistant' && m.parts.length === 0));
    const storedModel = await convertToModelMessages(storedUi, {
      ignoreIncompleteToolCalls: true,
    });
    const lastCall = model.doStreamCalls.at(-1);
    assert.ok(lastCall);
    const promptNoSystem = lastCall.prompt.filter(
      (message) => message.role !== 'system',
    );
    assert.deepStrictEqual(
      rolesOf(storedModel).slice(0, promptNoSystem.length),
      rolesOf(promptNoSystem),
      'stored chain must reproduce the model prompt role sequence',
    );
    // The model actually saw the steer reminder at the final step.
    assert.ok(
      JSON.stringify(promptNoSystem).includes(
        '<system-reminder>RECAP</system-reminder>',
      ),
      'model prompt at the steered step must contain the reminder',
    );
  });

  it('a bare constant predicate fires every mid-loop step (spam is by design)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'spam', userId: 'u1' });
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'done' },
    ]);
    const chatAgent = await makeAgent(context, model, 'spam');

    context.set(reminder('NUDGE', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('start'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'spam');
    const synthCount = chain.filter(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    ).length;
    // Two mid-loop steps (before the final text step) each fire — the engine
    // applies no firing control; dedup is the caller's job via once().
    assert.strictEqual(
      synthCount,
      2,
      `expected per-step fire, got ${synthCount}`,
    );
    // Synthetic steer users never inflate the turn count.
    assert.strictEqual(await context.getTurnCount(), 1);
  });

  it('once(id) latches a constant predicate to a single fire', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'latch', userId: 'u1' });
    const model = scriptedModel([
      { tool: 'noop' },
      { tool: 'noop' },
      { text: 'done' },
    ]);
    const chatAgent = await makeAgent(context, model, 'latch');

    context.set(
      reminder('NUDGE', {
        when: and(everyNTurns(1), once('nudge')),
        target: 'steer',
      }),
    );

    await context.continue(userMessage('start'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'latch');
    const synths = chain.filter(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    );
    assert.strictEqual(synths.length, 1, `once() must latch to one fire`);
    assert.deepStrictEqual(
      (
        synths[0].data as UIMessage as {
          metadata: { synthetic: { onceIds: string[] } };
        }
      ).metadata.synthetic.onceIds,
      ['nudge'],
      'the synth records the once id for durable suppression',
    );
  });

  it('once(id) is durable: a resumed conversation does NOT re-fire', async () => {
    const store = new InMemoryContextStore();
    const chatId = 'durable';

    // First run fires the latch.
    const c1 = new ContextEngine({ store, chatId, userId: 'u1' });
    const a1 = await makeAgent(
      c1,
      scriptedModel([{ tool: 'noop' }, { text: 'done' }]),
      'durable',
    );
    c1.set(
      reminder('NUDGE', {
        when: and(everyNTurns(1), once('nudge')),
        target: 'steer',
      }),
    );
    await c1.continue(userMessage('first run'));
    await drain(await chat(a1));

    // Second run on the SAME chat (fresh engine = simulated restart) re-registers
    // the same reminder. The persisted synth's onceId must suppress it.
    const c2 = new ContextEngine({ store, chatId, userId: 'u1' });
    const a2 = await makeAgent(
      c2,
      scriptedModel([{ tool: 'noop' }, { text: 'done' }]),
      'durable',
    );
    c2.set(
      reminder('NUDGE', {
        when: and(everyNTurns(1), once('nudge')),
        target: 'steer',
      }),
    );
    await c2.continue(userMessage('second run'));
    await drain(await chat(a2));

    const chain = await storedEntries(store, chatId);
    const synthCount = chain.filter(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    ).length;
    assert.strictEqual(
      synthCount,
      1,
      `once('nudge') fired in run 1 must not re-fire in run 2; got ${synthCount}`,
    );
  });

  it('once(id) latches only when consulted: a short-circuited or() does not latch', async () => {
    const store = new InMemoryContextStore();
    const chatId = 'consult';

    // Run 1: or() evaluates everyNTurns(1) (always true) first and short-circuits,
    // so once('shared') is never consulted. The reminder fires, but must NOT
    // latch 'shared'.
    const c1 = new ContextEngine({ store, chatId, userId: 'u1' });
    const a1 = await makeAgent(
      c1,
      scriptedModel([{ tool: 'noop' }, { text: 'done' }]),
      chatId,
    );
    c1.set(
      reminder('run1-nudge', {
        when: or(everyNTurns(1), once('shared')),
        target: 'steer',
      }),
    );
    await c1.continue(userMessage('run 1'));
    await drain(await chat(a1));

    // Run 2 (resumed conversation): a reminder genuinely gated by once('shared').
    // It must fire — run 1 never consulted 'shared', so it was never latched.
    const c2 = new ContextEngine({ store, chatId, userId: 'u1' });
    const a2 = await makeAgent(
      c2,
      scriptedModel([{ tool: 'noop' }, { text: 'done' }]),
      chatId,
    );
    c2.set(
      reminder('run2-nudge', {
        when: and(everyNTurns(1), once('shared')),
        target: 'steer',
      }),
    );
    await c2.continue(userMessage('run 2'));
    await drain(await chat(a2));

    const chain = await storedEntries(store, chatId);
    const firedRun2 = chain.some(
      (e) =>
        e.name === 'user' &&
        isSyntheticReminderMessage(e.data as UIMessage) &&
        textOf(e.data as UIMessage).includes('run2-nudge'),
    );
    assert.ok(
      firedRun2,
      "once('shared') was never consulted in run 1 (or short-circuited), so run 2 must still fire",
    );
  });

  it('once(id) is order-independent inside and()', async () => {
    for (const order of ['after', 'before'] as const) {
      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        store,
        chatId: `order-${order}`,
        userId: 'u1',
      });
      const model = scriptedModel([
        { tool: 'noop' },
        { tool: 'noop' },
        { text: 'done' },
      ]);
      const chatAgent = await makeAgent(context, model, `order-${order}`);

      const when =
        order === 'after'
          ? and(everyNTurns(1), once('o'))
          : and(once('o'), everyNTurns(1));
      context.set(reminder('NUDGE', { when, target: 'steer' }));

      await context.continue(userMessage('go'));
      await drain(await chat(chatAgent));

      const chain = await storedEntries(store, `order-${order}`);
      const synthCount = chain.filter(
        (e) =>
          e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
      ).length;
      assert.strictEqual(
        synthCount,
        1,
        `once() must latch once regardless of position in and() (${order}); got ${synthCount}`,
      );
    }
  });

  it('single-step (no tool) generation does NOT steer — there is no mid-loop moment', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'single',
      userId: 'u1',
    });
    const model = scriptedModel([{ text: 'just text' }]);
    const chatAgent = await makeAgent(context, model, 'single');

    context.set(reminder('NEVER', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('hi'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'single');
    assert.deepStrictEqual(
      chain.map((e) => e.name),
      ['user', 'assistant'],
    );
    assert.ok(textOf(chain[1].data as UIMessage).includes('just text'));
  });

  it('two steer reminders firing at the same boundary merge into one synthetic user (no consecutive users)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'two', userId: 'u1' });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'after' }]);
    const chatAgent = await makeAgent(context, model, 'two');

    context.set(
      reminder('FIRST', { when: everyNTurns(1), target: 'steer' }),
      reminder('SECOND', { when: everyNTurns(1), target: 'steer' }),
    );

    await context.continue(userMessage('go'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'two');
    assert.deepStrictEqual(
      chain.map((e) => e.name),
      ['user', 'assistant', 'user', 'assistant'],
    );
    const synth = chain[2].data as UIMessage;
    assert.ok(isSyntheticReminderMessage(synth));
    const synthText = textOf(synth);
    assert.ok(synthText.includes('FIRST') && synthText.includes('SECOND'));

    // No two consecutive user messages once converted for the model.
    const storedUi = chain
      .map((e) => e.data as UIMessage)
      .filter((m) => !(m.role === 'assistant' && m.parts.length === 0));
    const roles = rolesOf(
      await convertToModelMessages(storedUi, {
        ignoreIncompleteToolCalls: true,
      }),
    );
    for (let i = 1; i < roles.length; i++) {
      assert.ok(
        !(roles[i] === 'user' && roles[i - 1] === 'user'),
        `consecutive user messages at ${i}: ${roles.join(',')}`,
      );
    }
  });

  it('a throwing steer predicate does not kill the turn; other steer still fires', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'throws',
      userId: 'u1',
    });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'survived' }]);
    const chatAgent = await makeAgent(context, model, 'throws');

    context.set(
      reminder('BOOM', {
        when: () => {
          throw new Error('predicate exploded');
        },
        target: 'steer',
      }),
      reminder('OK', { when: everyNTurns(1), target: 'steer' }),
    );

    await context.continue(userMessage('go'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'throws');
    // The turn completed and produced its final assistant content.
    assert.ok(
      textOf(chain[chain.length - 1].data as UIMessage).includes('survived'),
      'turn must complete despite a throwing predicate',
    );
    const synth = chain.find(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    );
    assert.ok(synth, 'the non-throwing steer must still fire');
    assert.ok(textOf(synth.data as UIMessage).includes('OK'));
    assert.ok(!textOf(synth.data as UIMessage).includes('BOOM'));
  });

  it('no steer configured: a multi-step loop persists a single assistant (no split)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'plain', userId: 'u1' });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'final' }]);
    const chatAgent = await makeAgent(context, model, 'plain');

    await context.continue(userMessage('hello'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'plain');
    assert.deepStrictEqual(
      chain.map((e) => e.name),
      ['user', 'assistant'],
    );
  });

  it('stripReminders removes the synthetic steer payload (no system-reminder leak)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'strip', userId: 'u1' });
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }]);
    const chatAgent = await makeAgent(context, model, 'strip');

    context.set(reminder('SECRET', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('first real message'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'strip');
    const synth = chain.find(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    );
    assert.ok(synth);
    const stripped = stripReminders(synth.data as UIMessage);
    assert.ok(
      !textOf(stripped).includes('SECRET'),
      'stripped synthetic steer must not leak the reminder text',
    );

    // The title derives from the real first user, never the synthetic steer.
    const first = await context.firstUserMessage();
    assert.ok(first && textOf(first).includes('first real message'));
    assert.ok(!(first && isSyntheticReminderMessage(first)));
  });

  it('steer + guardrail retry: the steer synth is persisted exactly once and the chain stays coherent', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'gr', userId: 'u1' });
    // step0 tool (lets steer fire at prepareStep step1), step1 text that the
    // guardrail rejects once → retry, retry produces the final text.
    const model = scriptedModel([
      { tool: 'noop' },
      { text: 'first attempt' },
      { text: 'final answer' },
    ]);
    let guardrailHits = 0;
    const failOnce: Guardrail = {
      id: 'fail-once',
      name: 'fail-once',
      handle: (part) => {
        if (part.type === 'text-delta') {
          guardrailHits++;
          if (guardrailHits === 1) return fail('retry please');
        }
        return pass(part);
      },
    };
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    const chatAgent = agent({
      sandbox,
      name: 'gr',
      context,
      model,
      tools: { noop: noopTool },
      guardrails: [failOnce],
    });

    context.set(reminder('NUDGE', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('go'));
    await drain(
      await chat(chatAgent, { transform: () => new TransformStream() }),
    );

    const chain = await storedEntries(store, 'gr');
    const names = chain.map((e) => e.name);
    const synthCount = chain.filter(
      (e) =>
        e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
    ).length;

    assert.strictEqual(
      synthCount,
      1,
      `steer must persist exactly one synth across a guardrail retry; got ${synthCount} in ${JSON.stringify(names)}`,
    );
    const storedToolParts = chain
      .filter((entry) => entry.name === 'assistant')
      .flatMap((entry) => (entry.data as UIMessage).parts)
      .filter(isToolUIPart);
    assert.strictEqual(
      storedToolParts.length,
      1,
      'guardrail retry must not duplicate tool parts from the first attempt',
    );
    for (let i = 1; i < chain.length; i++) {
      assert.ok(
        !(chain[i].name === 'user' && chain[i - 1].name === 'user'),
        `no two consecutive user nodes; got ${JSON.stringify(names)}`,
      );
    }
  });

  it('keeps tool reminders ordered and cache-stable when a guardrail retry calls another tool', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'guardrail-tool-reminders',
      userId: 'u1',
    });
    const model = scriptedModel([
      { tool: 'firstTool' },
      { text: 'rejected answer' },
      { tool: 'secondTool' },
      { text: 'final answer' },
      { text: 'second turn answer' },
    ]);
    let rejected = false;
    const failFirstText: Guardrail = {
      id: 'fail-first-text',
      name: 'fail-first-text',
      handle: (part) => {
        if (part.type === 'text-delta' && !rejected) {
          rejected = true;
          return fail('retry with another tool');
        }
        return pass(part);
      },
    };
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    const chatAgent = agent({
      sandbox,
      name: 'guardrail-tool-reminders',
      context,
      model,
      tools: { firstTool: noopTool, secondTool: noopTool },
      guardrails: [failFirstText],
    });
    context.set(
      reminder('FIRST TOOL', {
        target: 'tool-output',
        when: toolOutput({ name: 'firstTool' }),
      }),
      reminder('SECOND TOOL', {
        target: 'tool-output',
        when: toolOutput({ name: 'secondTool' }),
      }),
    );

    await context.continue(userMessage('run both tools'));
    await drain(
      await chat(chatAgent, { transform: () => new TransformStream() }),
    );

    const chain = await storedEntries(store, 'guardrail-tool-reminders');
    assert.deepStrictEqual(
      chain.map((entry) => entry.name),
      ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
    );
    const toolTypes = chain
      .filter((entry) => entry.name === 'assistant')
      .flatMap((entry) => (entry.data as UIMessage).parts)
      .filter(isToolUIPart)
      .map((part) => part.type);
    assert.deepStrictEqual(toolTypes, ['tool-firstTool', 'tool-secondTool']);
    const reminderTexts = chain
      .filter(
        (entry) =>
          entry.name === 'user' &&
          isSyntheticReminderMessage(entry.data as UIMessage),
      )
      .map((entry) => textOf(entry.data as UIMessage));
    assert.deepStrictEqual(reminderTexts, [
      '<system-reminder>FIRST TOOL</system-reminder>',
      '<system-reminder>SECOND TOOL</system-reminder>',
    ]);

    const postRetryPrompt = structuredClone(model.doStreamCalls[3].prompt);
    await context.continue(userMessage('continue'));
    await drain(
      await chat(chatAgent, { transform: () => new TransformStream() }),
    );
    const resumedPrompt = model.doStreamCalls[4].prompt;
    assert.deepStrictEqual(
      resumedPrompt.slice(0, postRetryPrompt.length),
      postRetryPrompt,
    );
  });

  it('reminder({ target: "steer" }) without a when predicate throws a steer-specific error', () => {
    assert.throws(
      () => reminder('X', { target: 'steer' }),
      /Reminder target "steer" requires a when predicate/,
    );
  });

  it('elapsedExceeds fires every mid-loop step once past the threshold (no engine reset)', async () => {
    mock.timers.enable({ apis: ['Date'] });
    mock.timers.setTime(new Date('2026-06-08T10:00:00Z').getTime());
    try {
      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        store,
        chatId: 'recur',
        userId: 'u1',
      });
      const model = scriptedModel([
        { tool: 'slow' },
        { tool: 'slow' },
        { tool: 'slow' },
        { text: 'done' },
      ]);
      const slowTool = tool({
        description: 'a tool that takes 61 seconds',
        inputSchema: z.object({}),
        execute: async () => {
          mock.timers.tick(61_000);
          return { ok: true };
        },
      });
      const sandbox = await createBashTool({
        sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      });
      const chatAgent = agent({
        sandbox,
        name: 'recur',
        context,
        model,
        tools: { slow: slowTool },
      });

      context.set(
        reminder('NUDGE', { when: elapsedExceeds(60_000), target: 'steer' }),
      );

      await context.continue(userMessage('long-running task'));
      await drain(await chat(chatAgent));

      const chain = await storedEntries(store, 'recur');
      const synthCount = chain.filter(
        (e) =>
          e.name === 'user' && isSyntheticReminderMessage(e.data as UIMessage),
      ).length;
      // elapsed (from the real user, never reset by a nudge) is past 60s at all
      // three mid-loop steps, so a bare elapsedExceeds fires at each.
      assert.strictEqual(
        synthCount,
        3,
        `bare elapsedExceeds fires every step past threshold; got ${synthCount}`,
      );
    } finally {
      mock.timers.reset();
    }
  });
});
