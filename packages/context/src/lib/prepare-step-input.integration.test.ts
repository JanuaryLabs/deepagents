import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { type UIMessage, generateId, simulateReadableStream, tool } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  type Guardrail,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  everyNTurns,
  fail,
  pass,
  reminder,
} from '@deepagents/context';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

const sandbox = await createBashTool({
  sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
});

function message(text: string): UIMessage & { role: 'user' } {
  return {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

function textOf(messages: UIMessage[]): string {
  return messages
    .flatMap(({ parts }) =>
      parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
}

describe('prepare-step input integration', () => {
  it('persists first-request input in the model prompt and history', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'prepare-step-first-request',
      userId: 'user-1',
    });
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text-1' },
              { type: 'text-delta', id: 'text-1', delta: 'done' },
              { type: 'text-end', id: 'text-1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    const chatAgent = agent({
      name: 'prepare-step-agent',
      context,
      model,
      sandbox,
      prepareStepInput: async () => [message('mail before first request')],
    });

    await context.continue(message('original request'));
    await drain(await chat(chatAgent));

    assert.match(JSON.stringify(prompts[0]), /mail before first request/);
    assert.match(
      textOf(await context.getMessages()),
      /mail before first request/,
    );
  });

  it('persists caller input alongside a steer reminder at one safe boundary', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'prepare-step-with-reminder',
      userId: 'user-1',
    });
    context.set(
      reminder('remember the system rule', {
        when: everyNTurns(1),
        target: 'steer',
      }),
    );
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        calls++;
        const chunks: LanguageModelV4StreamPart[] =
          calls === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'noop-1',
                  toolName: 'noop',
                  input: '{}',
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: '' },
                  usage,
                },
              ]
            : [
                { type: 'text-start', id: 'text-2' },
                { type: 'text-delta', id: 'text-2', delta: 'done' },
                { type: 'text-end', id: 'text-2' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: '' },
                  usage,
                },
              ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    let providerCalls = 0;
    const chatAgent = agent({
      name: 'prepare-step-agent',
      context,
      model,
      sandbox,
      tools: {
        noop: tool({
          description: 'Continue to another model step',
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      prepareStepInput: async () => {
        providerCalls++;
        if (providerCalls !== 2) return undefined;
        return [message('mail at the safe boundary')];
      },
    });

    await context.continue(message('original request'));
    await drain(await chat(chatAgent));

    const secondPrompt = JSON.stringify(prompts[1]);
    assert.match(secondPrompt, /mail at the safe boundary/);
    assert.match(secondPrompt, /remember the system rule/);
    const history = textOf(await context.getMessages());
    assert.match(history, /mail at the safe boundary/);
    assert.match(history, /remember the system rule/);
  });

  it('persists caller input once before a guardrail retry', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'prepare-step-guardrail-retry',
      userId: 'user-1',
    });
    const prompts: unknown[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        calls++;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: `text-${calls}` },
              {
                type: 'text-delta',
                id: `text-${calls}`,
                delta: calls === 1 ? 'bad response' : 'good response',
              },
              { type: 'text-end', id: `text-${calls}` },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: '' },
                usage,
              },
            ],
          }),
        };
      },
    });
    let guardrailCalls = 0;
    const failOnce: Guardrail = {
      id: 'fail-once',
      name: 'fail-once',
      handle(part) {
        if (part.type === 'text-delta') {
          guardrailCalls++;
          if (guardrailCalls === 1) return fail('retry');
        }
        return pass(part);
      },
    };
    let provided = false;
    const chatAgent = agent({
      name: 'prepare-step-agent',
      context,
      model,
      sandbox,
      guardrails: [failOnce],
      prepareStepInput: async () => {
        if (provided) return undefined;
        provided = true;
        return [message('mail before guarded request')];
      },
    });

    await context.continue(message('original request'));
    await drain(
      await chat(chatAgent, {
        transform: () => new TransformStream(),
      }),
    );

    assert.equal(prompts.length, 2);
    assert.match(JSON.stringify(prompts[0]), /mail before guarded request/);
    assert.match(JSON.stringify(prompts[1]), /mail before guarded request/);
    assert.equal(
      textOf(await context.getMessages()).match(/mail before guarded request/g)
        ?.length,
      1,
    );
  });

  it('does not consume durable step input in the non-persisting generate path', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'prepare-step-generate',
      userId: 'user-1',
    });
    let prompt: unknown;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompt = options.prompt;
        return {
          content: [{ type: 'text' as const, text: 'done' }],
          finishReason: { unified: 'stop' as const, raw: '' },
          usage,
          warnings: [],
        };
      },
    });
    let providerCalls = 0;
    const generatingAgent = agent({
      name: 'prepare-step-agent',
      context,
      model,
      sandbox,
      prepareStepInput: async () => {
        providerCalls++;
        return [message('mail that requires durable history')];
      },
    });

    await context.continue(message('original request'));
    await generatingAgent.generate({});

    assert.equal(providerCalls, 0);
    assert.doesNotMatch(
      JSON.stringify(prompt),
      /mail that requires durable history/,
    );
  });
});
