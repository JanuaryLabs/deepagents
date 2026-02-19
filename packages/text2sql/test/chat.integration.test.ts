import { type UIMessage, generateId } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ContextEngine, InMemoryContextStore } from '@deepagents/context';
import { Text2Sql } from '@deepagents/text2sql';

import { init_db } from '../src/tests/sqlite.ts';

const testUsage = {
  inputTokens: { total: 10 },
  outputTokens: { total: 5 },
} as const;

function createMockModel(
  text = 'Here is your SQL: SELECT count(*) FROM users',
) {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: text },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: '' },
            usage: testUsage,
          },
        ],
      }),
      rawCall: { rawPrompt: undefined, rawSettings: {} },
    }),
  });
}

function userMessage(text: string): UIMessage {
  return {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

async function setup(mockText?: string) {
  const store = new InMemoryContextStore();
  const { adapter } = await init_db(
    'CREATE TABLE users (id INTEGER, name TEXT)',
  );
  const model = createMockModel(mockText);

  const text2sql = new Text2Sql({
    version: 'test',
    adapter,
    model,
    filesystem: new InMemoryFs(),
    transform: () => new TransformStream(),
    context: (...fragments) => {
      const engine = new ContextEngine({
        store,
        chatId: 'test-chat',
        userId: 'test-user',
      });
      engine.set(...fragments);
      return engine;
    },
  });

  return { store, text2sql };
}

describe('Text2Sql.chat()', () => {
  it('saves user message to context store', async () => {
    const { store, text2sql } = await setup();
    const msg = userMessage('How many users are there?');

    const stream = await text2sql.chat([msg]);
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId, 'branch should have a head message');

    const chain = await store.getMessageChain(branch.headMessageId);
    const persisted = chain.find((m) => m.name === 'user');
    assert.ok(persisted, 'user message should be persisted');

    const data = persisted.data as UIMessage;
    const textPart = data.parts?.find((p: any) => p.type === 'text');
    assert.strictEqual(textPart?.text, 'How many users are there?');
  });

  it('saves assistant response to context store after stream is consumed', async () => {
    const { store, text2sql } = await setup('SELECT count(*) FROM users');
    const msg = userMessage('How many users?');

    const stream = await text2sql.chat([msg]);
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find((m) => m.name === 'assistant');
    assert.ok(assistantMsg, 'assistant message should be persisted');

    const data = assistantMsg.data as UIMessage;
    assert.ok(
      data.parts && data.parts.length > 0,
      'assistant message should have parts',
    );
  });

  it('does not create extra branches during streaming (branch: false)', async () => {
    const { store, text2sql } = await setup();
    const msg = userMessage('List all users');

    const stream = await text2sql.chat([msg]);
    await drain(stream);

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(
      branches.length,
      1,
      `expected 1 branch (main), got ${branches.length}: ${branches.map((b) => b.name).join(', ')}`,
    );
    assert.strictEqual(branches[0].name, 'main');
  });

  it('tracks token usage in chat metadata', async () => {
    const { store, text2sql } = await setup();
    const msg = userMessage('Count users');

    const stream = await text2sql.chat([msg]);
    await drain(stream);

    const chat = await store.getChat('test-chat');
    assert.ok(chat, 'chat should exist');
    assert.ok(chat.metadata?.usage, 'chat metadata should have usage');

    const usage = chat.metadata.usage as Record<string, number>;
    assert.ok(usage.inputTokens > 0, 'inputTokens should be > 0');
    assert.ok(usage.outputTokens > 0, 'outputTokens should be > 0');
    assert.ok(usage.totalTokens > 0, 'totalTokens should be > 0');
  });

  it('attaches createdFiles metadata to assistant message', async () => {
    const { store, text2sql } = await setup();
    const msg = userMessage('Show users');

    const stream = await text2sql.chat([msg]);
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find((m) => m.name === 'assistant');
    assert.ok(assistantMsg, 'assistant message should exist');

    const data = assistantMsg.data as UIMessage & {
      metadata?: Record<string, unknown>;
    };
    assert.ok(data.metadata, 'assistant message should have metadata');
    assert.ok(
      Array.isArray(data.metadata.createdFiles),
      'metadata should have createdFiles array',
    );
  });
});
