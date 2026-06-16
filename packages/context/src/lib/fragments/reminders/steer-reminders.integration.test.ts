import {
  type UIMessage,
  convertToModelMessages,
  generateId,
  simulateReadableStream,
  tool,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { z } from 'zod';

import {
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
  isSyntheticSteerMessage,
  once,
  or,
  pass,
  reminder,
  stripReminders,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

type StepSpec = { tool: string } | { text: string };

/**
 * A V3 mock that scripts one model step per spec: `{tool}` emits a tool call and
 * keeps the loop going; `{text}` emits text and stops. `prompts` collects the
 * model prompt seen at each step so tests can assert store/prompt parity.
 */
function scriptedModel(steps: StepSpec[], prompts: unknown[][]) {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      prompts.push(prompt as unknown[]);
      const spec = steps[Math.min(call, steps.length - 1)];
      call++;
      const id = `s${call}`;
      const chunks: Record<string, unknown>[] = [];
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
        stream: simulateReadableStream({ chunks: chunks as never }),
        rawCall: { rawPrompt: undefined, rawSettings: {} },
      };
    },
  });
}

const noopTool = tool({
  description: 'A no-op tool used to drive multi-step loops.',
  inputSchema: z.object({}),
  execute: async () => ({ ok: true }),
});

async function makeAgent(
  context: ContextEngine,
  model: MockLanguageModelV3,
  name: string,
) {
  const sandbox = await createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
  return agent({ sandbox, name, context, model, tools: { noop: noopTool } });
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
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

describe('steer reminders integration (chat flow)', () => {
  it('fires mid-loop: stored chain splits assistant and matches the model prompt (parity)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'mid', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'noop' }, { text: 'post-steer answer' }],
      prompts,
    );
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
      isSyntheticSteerMessage(synth),
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
    const storedModel = await convertToModelMessages(storedUi as never, {
      ignoreIncompleteToolCalls: true,
    });
    const promptNoSystem = (
      prompts[prompts.length - 1] as { role: string }[]
    ).filter((m) => m.role !== 'system');
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
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'noop' }, { tool: 'noop' }, { text: 'done' }],
      prompts,
    );
    const chatAgent = await makeAgent(context, model, 'spam');

    context.set(reminder('NUDGE', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('start'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'spam');
    const synthCount = chain.filter(
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'noop' }, { tool: 'noop' }, { text: 'done' }],
      prompts,
    );
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
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
      scriptedModel([{ tool: 'noop' }, { text: 'done' }], []),
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
      scriptedModel([{ tool: 'noop' }, { text: 'done' }], []),
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
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
      scriptedModel([{ tool: 'noop' }, { text: 'done' }], []),
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
      scriptedModel([{ tool: 'noop' }, { text: 'done' }], []),
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
        isSyntheticSteerMessage(e.data as UIMessage) &&
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
      const model = scriptedModel(
        [{ tool: 'noop' }, { tool: 'noop' }, { text: 'done' }],
        [],
      );
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
          e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ text: 'just text' }], prompts);
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
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'after' }], prompts);
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
    assert.ok(isSyntheticSteerMessage(synth));
    const synthText = textOf(synth);
    assert.ok(synthText.includes('FIRST') && synthText.includes('SECOND'));

    // No two consecutive user messages once converted for the model.
    const storedUi = chain
      .map((e) => e.data as UIMessage)
      .filter((m) => !(m.role === 'assistant' && m.parts.length === 0));
    const roles = rolesOf(
      await convertToModelMessages(storedUi as never, {
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
    const prompts: unknown[][] = [];
    const model = scriptedModel(
      [{ tool: 'noop' }, { text: 'survived' }],
      prompts,
    );
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
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
    );
    assert.ok(synth, 'the non-throwing steer must still fire');
    assert.ok(textOf(synth.data as UIMessage).includes('OK'));
    assert.ok(!textOf(synth.data as UIMessage).includes('BOOM'));
  });

  it('no steer configured: a multi-step loop persists a single assistant (no split)', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'plain', userId: 'u1' });
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'final' }], prompts);
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
    const prompts: unknown[][] = [];
    const model = scriptedModel([{ tool: 'noop' }, { text: 'done' }], prompts);
    const chatAgent = await makeAgent(context, model, 'strip');

    context.set(reminder('SECRET', { when: everyNTurns(1), target: 'steer' }));

    await context.continue(userMessage('first real message'));
    await drain(await chat(chatAgent));

    const chain = await storedEntries(store, 'strip');
    const synth = chain.find(
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
    assert.ok(!(first && isSyntheticSteerMessage(first)));
  });

  it('steer + guardrail retry: the steer synth is persisted exactly once and the chain stays coherent', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({ store, chatId: 'gr', userId: 'u1' });
    // step0 tool (lets steer fire at prepareStep step1), step1 text that the
    // guardrail rejects once → retry, retry produces the final text.
    const model = scriptedModel(
      [{ tool: 'noop' }, { text: 'first attempt' }, { text: 'final answer' }],
      [],
    );
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
      (e) => e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
    ).length;

    assert.strictEqual(
      synthCount,
      1,
      `steer must persist exactly one synth across a guardrail retry; got ${synthCount} in ${JSON.stringify(names)}`,
    );
    for (let i = 1; i < chain.length; i++) {
      assert.ok(
        !(chain[i].name === 'user' && chain[i - 1].name === 'user'),
        `no two consecutive user nodes; got ${JSON.stringify(names)}`,
      );
    }
  });

  it('reminder({ target: "steer" }) without a when predicate throws a steer-specific error', () => {
    assert.throws(
      () => reminder('X', { target: 'steer' } as never),
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
      const model = scriptedModel(
        [
          { tool: 'slow' },
          { tool: 'slow' },
          { tool: 'slow' },
          { text: 'done' },
        ],
        [],
      );
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
          e.name === 'user' && isSyntheticSteerMessage(e.data as UIMessage),
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
