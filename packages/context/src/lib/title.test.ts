import { type UIMessage, generateId } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  TitleGenerator,
  message,
  user,
} from '@deepagents/context';

const EXISTING_TITLE = 'Existing Title';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function modelReturningTitle(title: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ title }) }],
      finishReason: { unified: 'stop' as const, raw: '' },
      usage: testUsage,
      warnings: [],
    }),
  });
}

function freshContext(chatId: string) {
  const store = new InMemoryContextStore();
  const context = new ContextEngine({
    store,
    chatId,
    userId: 'test-user',
  });
  return { store, context };
}

describe('TitleGenerator.ensure()', () => {
  it('uses LLM and persists generated title', async () => {
    const { store, context } = freshContext('ensure-llm');
    context.set(user('help with python'));
    await context.save();

    const titler = new TitleGenerator({ context });
    const result = await titler.ensure({
      model: modelReturningTitle('Python Help'),
    });

    assert.deepStrictEqual(result, { title: 'Python Help', source: 'llm' });
    assert.strictEqual(
      (await store.getChat('ensure-llm'))?.title,
      'Python Help',
    );
  });

  it('returns null and skips LLM when title already set', async () => {
    const { store, context } = freshContext('ensure-titled');
    context.set(user('hello'));
    await context.save();
    await context.updateChat({ title: EXISTING_TITLE });

    let modelInvoked = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelInvoked = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ title: 'Wrong' }) }],
          finishReason: { unified: 'stop' as const, raw: '' },
          usage: testUsage,
          warnings: [],
        };
      },
    });

    const titler = new TitleGenerator({ context });
    const result = await titler.ensure({ model });

    assert.strictEqual(result, null);
    assert.strictEqual(modelInvoked, false);
    assert.strictEqual(
      (await store.getChat('ensure-titled'))?.title,
      EXISTING_TITLE,
    );
  });

  it('returns null when no user message exists in chain or pending', async () => {
    const { store, context } = freshContext('ensure-empty');

    const titler = new TitleGenerator({ context });
    const result = await titler.ensure({
      model: modelReturningTitle('Should Not Run'),
    });

    assert.strictEqual(result, null);
    assert.strictEqual(
      (await store.getChat('ensure-empty'))?.title ?? null,
      null,
    );
  });

  it('falls back to static title with source=static when LLM throws', async () => {
    const { store, context } = freshContext('ensure-llm-error');
    context.set(user('help me'));
    await context.save();

    const erroringModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error('LLM unavailable');
      },
    });

    const titler = new TitleGenerator({ context });
    const result = await titler.ensure({ model: erroringModel });

    assert.deepStrictEqual(result, { title: 'help me', source: 'static' });
    assert.strictEqual(
      (await store.getChat('ensure-llm-error'))?.title,
      'help me',
    );
  });

  it('forwards abortSignal to the model and falls back when the model aborts', async () => {
    const { context } = freshContext('ensure-abort');
    context.set(user('do work'));
    await context.save();

    const controller = new AbortController();
    controller.abort();

    let signalSeen: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        signalSeen = options.abortSignal;
        if (options.abortSignal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ title: 'Wrong' }) }],
          finishReason: { unified: 'stop' as const, raw: '' },
          usage: testUsage,
          warnings: [],
        };
      },
    });

    const titler = new TitleGenerator({ context });
    const result = await titler.ensure({
      model,
      abortSignal: controller.signal,
    });

    assert.strictEqual(signalSeen, controller.signal);
    assert.deepStrictEqual(result, { title: 'do work', source: 'static' });
  });
});

describe('TitleGenerator.ensureStatic()', () => {
  it('uses static truncation and persists title from persisted chain', async () => {
    const { store, context } = freshContext('static-chain');
    context.set(user('plain user message'));
    await context.save();

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, {
      title: 'plain user message',
      source: 'static',
    });
    assert.strictEqual(
      (await store.getChat('static-chain'))?.title,
      'plain user message',
    );
  });

  it('reads first user from pending when chain is empty', async () => {
    const { store, context } = freshContext('static-pending');
    context.set(user('only in pending'));

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, {
      title: 'only in pending',
      source: 'static',
    });
    assert.strictEqual(
      (await store.getChat('static-pending'))?.title,
      'only in pending',
    );
  });

  it('prefers persisted chain user over a newer pending user', async () => {
    const { context } = freshContext('static-chain-precedence');
    context.set(user('first persisted'));
    await context.save();
    context.set(user('newer pending'));

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, {
      title: 'first persisted',
      source: 'static',
    });
  });

  it('truncates user content over 100 chars and appends ellipsis', async () => {
    const { context } = freshContext('static-truncate');
    context.set(user('x'.repeat(150)));
    await context.save();

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, {
      title: 'x'.repeat(100) + '...',
      source: 'static',
    });
  });

  it('preserves exact 100-char user content without truncation', async () => {
    const { context } = freshContext('static-exact-100');
    const exactText = 'y'.repeat(100);
    context.set(user(exactText));
    await context.save();

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, { title: exactText, source: 'static' });
  });

  it('returns null when title already set', async () => {
    const { store, context } = freshContext('static-titled');
    context.set(user('hello'));
    await context.save();
    await context.updateChat({ title: EXISTING_TITLE });

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.strictEqual(result, null);
    assert.strictEqual(
      (await store.getChat('static-titled'))?.title,
      EXISTING_TITLE,
    );
  });

  it("returns 'New Chat' when first user message has no text part", async () => {
    const { context } = freshContext('static-no-text');
    const fileOnly: UIMessage = {
      id: generateId(),
      role: 'user',
      parts: [
        {
          type: 'file',
          url: 'https://example.com/img.png',
          mediaType: 'image/png',
        },
      ],
    };
    context.set(message(fileOnly));
    await context.save();

    const titler = new TitleGenerator({ context });
    const result = await titler.ensureStatic();

    assert.deepStrictEqual(result, { title: 'New Chat', source: 'static' });
  });
});
