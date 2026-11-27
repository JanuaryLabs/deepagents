import { describe, it } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import {
  type UIMessage,
  type UIMessageChunk,
  generateId,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';

import {
  ContextEngine,
  type ContextStore,
  InMemoryContextStore,
  PostgresContextStore,
  agent,
  chat,
} from '@deepagents/context';

import { buildSandbox } from './helpers/build-sandbox.ts';
import { usage } from './helpers/usage.ts';

const testPostgres = new Postgres({ environment: process.env });

const QUESTION = 'How do I renew my passport in Jordan?';

function answeringModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
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

function titleResult(title: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
    finishReason: { unified: 'stop' as const, raw: '' },
    usage,
    warnings: [],
  };
}

function heldTitleModel(title: string) {
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      await release.promise;
      return titleResult(title);
    },
  });
  return { model, release: () => release.resolve() };
}

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

function streamedTitles(chunks: UIMessageChunk[]) {
  return chunks.flatMap((chunk) =>
    chunk.type === 'data-chat-title' ? [chunk.data] : [],
  );
}

async function turn(
  store: ContextStore,
  chatId: string,
  text: string,
  title?: { model: MockLanguageModelV4 },
) {
  const context = new ContextEngine({ store, chatId, userId: 'user-1' });
  const chatAgent = agent({
    sandbox: await buildSandbox(),
    name: 'assistant',
    context,
    model: answeringModel('Visit the Civil Status Department.'),
  });
  await context.continue(userMessage(text));
  return chat(chatAgent, { title });
}

describe('chat() titles', () => {
  it('stores the first message as the title when no title model is given', async () => {
    const store = new InMemoryContextStore();

    await Array.fromAsync(await turn(store, 'static-title', QUESTION));

    assert.strictEqual((await store.getChat('static-title'))?.title, QUESTION);
  });

  it('replaces the first-message title with the generated one, and titles a chat once', async () => {
    const store = new InMemoryContextStore();
    const titleModel = new MockLanguageModelV4({
      doGenerate: titleResult('Passport renewal'),
    });

    const first = await Array.fromAsync(
      await turn(store, 'generated-title', QUESTION, { model: titleModel }),
    );
    await Array.fromAsync(
      await turn(store, 'generated-title', 'And for my children?', {
        model: titleModel,
      }),
    );

    assert.deepStrictEqual(
      {
        stored: (await store.getChat('generated-title'))?.title,
        streamed: streamedTitles(first),
        titleCalls: titleModel.doGenerateCalls.length,
      },
      {
        stored: 'Passport renewal',
        streamed: ['Passport renewal'],
        titleCalls: 1,
      },
    );
  });

  it('keeps the first-message title when the title model fails', async () => {
    const store = new InMemoryContextStore();
    const titleModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('title model unavailable');
      },
    });

    await Array.fromAsync(
      await turn(store, 'failed-title', QUESTION, { model: titleModel }),
    );

    assert.deepStrictEqual(
      {
        stored: (await store.getChat('failed-title'))?.title,
        titleCalls: titleModel.doGenerateCalls.length,
      },
      { stored: QUESTION, titleCalls: 1 },
    );
  });

  it('streams the answer, with the first-message title stored, while the title model is still running', async (t) => {
    const store = new InMemoryContextStore();
    const title = heldTitleModel('Passport renewal');
    try {
      const reader = (
        await turn(store, 'held-title', QUESTION, { model: title.model })
      ).getReader();

      await waitFor(
        () => assert.strictEqual(title.model.doGenerateCalls.length, 1),
        { signal: t.signal },
      );
      let answer = '';
      while (answer !== 'Visit the Civil Status Department.') {
        const { done, value } = await reader.read();
        assert.strictEqual(done, false, `stream ended after "${answer}"`);
        if (value.type === 'text-delta') answer += value.delta;
      }

      assert.strictEqual((await store.getChat('held-title'))?.title, QUESTION);
      title.release();
      const rest: UIMessageChunk[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest.push(value);
      }
      assert.deepStrictEqual(streamedTitles(rest), ['Passport renewal']);
    } finally {
      title.release();
    }
  });

  void it.each(
    [
      {
        name: 'in memory',
        stores: async () => {
          const store = new InMemoryContextStore();
          return {
            host: store,
            other: store,
            [Symbol.asyncDispose]: async () => {},
          };
        },
      },
      {
        name: 'on Postgres',
        stores: async () => {
          const container = await testPostgres.database();
          return {
            host: await PostgresContextStore.create({ pool: container.pool() }),
            other: await PostgresContextStore.create({
              pool: container.pool(),
            }),
            [Symbol.asyncDispose]: () => container[Symbol.asyncDispose](),
          };
        },
      },
    ],
    (variant) =>
      it(`keeps a rename made while the title model runs (${variant.name})`, async (t) => {
        await using stores = await variant.stores();
        const title = heldTitleModel('Passport renewal');
        try {
          const stream = await turn(stores.host, 'renamed', QUESTION, {
            model: title.model,
          });
          const chunks = Array.fromAsync(stream);
          await waitFor(
            () => assert.strictEqual(title.model.doGenerateCalls.length, 1),
            { signal: t.signal },
          );

          await stores.other.updateChat('renamed', () => ({
            title: 'Jordan passport',
          }));
          title.release();

          assert.deepStrictEqual(
            {
              streamed: streamedTitles(await chunks),
              stored: (await stores.other.getChat('renamed'))?.title,
            },
            { streamed: [], stored: 'Jordan passport' },
          );
        } finally {
          title.release();
        }
      }),
  );
});
