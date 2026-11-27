import { type UIMessage, generateId, simulateReadableStream } from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
} from '@deepagents/context';

import { buildSandbox } from '../../test/helpers/build-sandbox.ts';
import { usage } from '../../test/helpers/usage.ts';

const sandbox = await buildSandbox();

function answerModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: 'Answer' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage,
          },
        ],
      }),
    }),
  });
}

function titleModel(title: string) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
      finishReason: { unified: 'stop' as const, raw: '' },
      usage,
      warnings: [],
    },
  });
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

async function firstTurn(chatId: string) {
  const store = new InMemoryContextStore();
  const context = new ContextEngine({ store, chatId, userId: 'test-user' });
  await context.continue(userMessage('apixaban dose in renal impairment'));
  return { store, context };
}

describe('chat() title providerOptions', () => {
  it('sends the title option providerOptions with the title model call', async () => {
    const { store, context } = await firstTurn('title-provider-options');
    const model = titleModel('Apixaban Renal Dosing');
    const providerOptions = {
      openrouter: {
        user: 'doctor-1',
        provider: { data_collection: 'deny', zdr: true },
      },
    };

    await drain(
      await chat(
        agent({ sandbox, name: 'assistant', context, model: answerModel() }),
        { title: { model, providerOptions } },
      ),
    );

    assert.strictEqual(model.doGenerateCalls.length, 1);
    assert.deepStrictEqual(
      model.doGenerateCalls[0].providerOptions,
      providerOptions,
    );
    assert.strictEqual(
      (await store.getChat('title-provider-options'))?.title,
      'Apixaban Renal Dosing',
    );
  });

  it('generates the title when the title option gives only a model', async () => {
    const { store, context } = await firstTurn('title-model-only');
    const model = titleModel('Apixaban Renal Dosing');

    await drain(
      await chat(
        agent({ sandbox, name: 'assistant', context, model: answerModel() }),
        { title: { model } },
      ),
    );

    assert.strictEqual(model.doGenerateCalls.length, 1);
    assert.strictEqual(model.doGenerateCalls[0].providerOptions, undefined);
    assert.strictEqual(
      (await store.getChat('title-model-only'))?.title,
      'Apixaban Renal Dosing',
    );
  });
});
