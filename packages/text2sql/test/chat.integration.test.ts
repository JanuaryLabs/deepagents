import {
  type UIMessage,
  generateId,
  simulateReadableStream,
  validateUIMessages,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createVirtualSandbox,
  errorRecoveryGuardrail,
  reminder,
  user,
} from '@deepagents/context';
import { Sqlite as TestSqlite } from '@deepagents/test';
import {
  AdapterIndexer,
  FileIndexCache,
  FileIndexLock,
  type IndexCache,
  instructions,
} from '@deepagents/text2sql';
import { Sqlite } from '@deepagents/text2sql/sqlite';

const sqlite = new TestSqlite();

const sandbox = await createBashTool({
  sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
});

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function createMockModel(
  text = 'Here is your SQL: SELECT count(*) FROM users',
) {
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
            usage: testUsage,
          },
        ],
      }),
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

async function setup(mockText?: string) {
  await using resources = new AsyncDisposableStack();
  const database = resources.use(await sqlite.database());
  const store = new InMemoryContextStore();
  database.connection.exec('CREATE TABLE users (id INTEGER, name TEXT)');
  const adapter = new Sqlite({
    execute: (sql) => database.connection.prepare(sql).all(),
    grounding: [],
  });
  const model = createMockModel(mockText);
  const engine = new ContextEngine({
    store,
    chatId: 'test-chat',
    userId: 'test-user',
  });

  const adapters = { main: adapter };
  const cache = new FileIndexCache({ namespace: `test-${generateId()}` });

  const owned = resources.move();
  return {
    store,
    adapters,
    cache,
    engine,
    model,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

function indexFragments(adapters: Record<string, Sqlite>, cache?: IndexCache) {
  return new AdapterIndexer({
    adapters,
    cache,
    lock: new FileIndexLock({ namespace: generateId() }),
  }).index();
}

describe('Text2Sql user-constructed chat', () => {
  it('saves user message to context store', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;
    const msg = userMessage('How many users are there?');

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    await engine.continue(msg);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId, 'branch should have a head message');

    const chain = await store.getMessageChain(branch.headMessageId);
    const persisted = chain.find((m) => m.name === 'user');
    assert.ok(persisted, 'user message should be persisted');

    const [data] = await validateUIMessages({ messages: [persisted.data] });
    const textPart = data.parts.find((part) => part.type === 'text');
    assert.strictEqual(textPart?.text, 'How many users are there?');
  });

  it('saves assistant response to context store after stream is consumed', async () => {
    await using fixture = await setup('SELECT count(*) FROM users');
    const { store, adapters, cache, engine, model } = fixture;
    const msg = userMessage('How many users?');

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    await engine.continue(msg);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find((m) => m.name === 'assistant');
    assert.ok(assistantMsg, 'assistant message should be persisted');

    const [data] = await validateUIMessages({
      messages: [assistantMsg.data],
    });
    assert.ok(
      data.parts && data.parts.length > 0,
      'assistant message should have parts',
    );
  });

  it('does not create extra branches during streaming (branch: false)', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;
    const msg = userMessage('List all users');

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    await engine.continue(msg);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
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
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;
    const msg = userMessage('Count users');

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    await engine.continue(msg);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const persistedChat = await store.getChat('test-chat');
    assert.ok(persistedChat, 'chat should exist');
    assert.ok(persistedChat.metadata?.usage, 'chat metadata should have usage');

    const usage = z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        totalTokens: z.number(),
      })
      .parse(persistedChat.metadata.usage);
    assert.ok(usage.inputTokens > 0, 'inputTokens should be > 0');
    assert.ok(usage.outputTokens > 0, 'outputTokens should be > 0');
    assert.ok(usage.totalTokens > 0, 'totalTokens should be > 0');
  });

  it('updates assistant message in place for tool result scenario', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const msg = userMessage('How many users?');
    await engine.continue(msg);
    const stream1 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream1);

    const branch1 = await store.getActiveBranch('test-chat');
    assert.ok(branch1?.headMessageId);
    const chain1 = await store.getMessageChain(branch1.headMessageId);
    const savedAssistant = chain1.find((m) => m.name === 'assistant');
    assert.ok(
      savedAssistant,
      'assistant message should exist after first call',
    );

    const updatedAssistantMsg: UIMessage = {
      id: savedAssistant.id,
      role: 'assistant',
      parts: [
        { type: 'text' as const, text: 'Updated answer after tool result' },
      ],
    };

    await engine.continue(updatedAssistantMsg);
    const stream2 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream2);

    const branch2 = await store.getActiveBranch('test-chat');
    assert.ok(branch2?.headMessageId);
    const chain2 = await store.getMessageChain(branch2.headMessageId);

    assert.strictEqual(
      chain2.length,
      2,
      `expected 2 messages (user + assistant updated in-place), got ${chain2.length}`,
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(
      branches.length,
      1,
      'tool result should not create new branches',
    );
  });

  it('grows chain correctly across multiple normal user turns', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const msg1 = userMessage('How many users?');
    await engine.continue(msg1);
    const stream1 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream1);

    const branch1 = await store.getActiveBranch('test-chat');
    assert.ok(branch1?.headMessageId);
    const chain1 = await store.getMessageChain(branch1.headMessageId);
    assert.strictEqual(chain1.length, 2, 'first turn: user + assistant');

    const msg2 = userMessage('Show me the first 10');
    await engine.continue(msg2);
    const stream2 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream2);

    const branch2 = await store.getActiveBranch('test-chat');
    assert.ok(branch2?.headMessageId);
    const chain2 = await store.getMessageChain(branch2.headMessageId);
    assert.strictEqual(
      chain2.length,
      4,
      'second turn: user1 + assistant1 + user2 + assistant2',
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(
      branches.length,
      1,
      'no branching for normal user turns',
    );
  });

  it('does not branch when assistant message ID is not in store', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const msg = userMessage('Hello');
    await engine.continue(msg);
    const freshAssistant: UIMessage = {
      id: generateId(),
      role: 'assistant',
      parts: [{ type: 'text' as const, text: 'Fresh assistant not in store' }],
    };

    await engine.continue(freshAssistant);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(
      branches.length,
      1,
      'no branching for fresh assistant ID',
    );
  });

  it('handles multiple consecutive tool-result rounds correctly', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const msg1 = userMessage('Analyze users');
    await engine.continue(msg1);
    const stream1 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream1);

    const branch1 = await store.getActiveBranch('test-chat');
    assert.ok(branch1?.headMessageId);
    const chain1 = await store.getMessageChain(branch1.headMessageId);
    const assistant1 = chain1.find((m) => m.name === 'assistant');
    assert.ok(assistant1);

    const toolResult1: UIMessage = {
      id: assistant1.id,
      role: 'assistant',
      parts: [{ type: 'text' as const, text: 'After first tool result' }],
    };
    await engine.continue(toolResult1);
    const stream2 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream2);

    const branch2 = await store.getActiveBranch('test-chat');
    assert.ok(branch2?.headMessageId);
    const chain2 = await store.getMessageChain(branch2.headMessageId);
    assert.strictEqual(
      chain2.length,
      2,
      'second round: user + assistant (in-place)',
    );

    const assistant2 = chain2.find((m) => m.name === 'assistant');
    assert.ok(assistant2);

    const toolResult2: UIMessage = {
      id: assistant2.id,
      role: 'assistant',
      parts: [{ type: 'text' as const, text: 'After second tool result' }],
    };
    await engine.continue(toolResult2);
    const stream3 = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream3);

    const branch3 = await store.getActiveBranch('test-chat');
    assert.ok(branch3?.headMessageId);
    const chain3 = await store.getMessageChain(branch3.headMessageId);
    assert.strictEqual(
      chain3.length,
      2,
      'third round: user + assistant (in-place)',
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(
      branches.length,
      1,
      'tool results should not create new branches',
    );
  });

  it('forwards abortSignal to agent stream', async () => {
    const store = new InMemoryContextStore();
    await using database = await sqlite.database();
    database.connection.exec('CREATE TABLE users (id INTEGER, name TEXT)');
    const adapter = new Sqlite({
      execute: (sql) => database.connection.prepare(sql).all(),
      grounding: [],
    });

    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'response' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: '' },
              usage: testUsage,
            },
          ],
        }),
      },
    });

    const engine = new ContextEngine({
      store,
      chatId: 'test-chat-signal',
      userId: 'test-user',
    });
    const adapters = { main: adapter };
    const cache = new FileIndexCache({
      namespace: `test-signal-${generateId()}`,
    });

    engine.set(...instructions(), ...(await indexFragments(adapters, cache)));
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    const controller = new AbortController();
    const msg = userMessage('How many users?');
    await engine.continue(msg);
    const stream = await chat(ai, {
      abortSignal: controller.signal,
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const receivedSignal = model.doStreamCalls[0].abortSignal;
    assert.ok(receivedSignal, 'model should receive an AbortSignal');
    controller.abort();
    assert.ok(
      receivedSignal.aborted,
      'aborting controller should propagate to model signal',
    );
  });

  it('accepts MessageFragment with reminders and persists reminder metadata', async () => {
    await using fixture = await setup();
    const { store, adapters, cache, engine, model } = fixture;
    const fragment = user('How many users are there?');

    engine.set(
      reminder('Always explain your SQL before writing it'),
      ...instructions(),
      ...(await indexFragments(adapters, cache)),
    );
    const ai = agent({
      name: 'text2sql',
      sandbox,
      model,
      context: engine,
      guardrails: [errorRecoveryGuardrail],
      maxGuardrailRetries: 3,
    });

    await engine.continue(fragment);
    const stream = await chat(ai, {
      transform: () => new TransformStream(),
    });
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId, 'branch should have a head message');

    const chain = await store.getMessageChain(branch.headMessageId);
    const persisted = chain.find((m) => m.name === 'user');
    assert.ok(persisted, 'user message should be persisted');

    const [data] = await validateUIMessages({ messages: [persisted.data] });
    const textPart = data.parts.find((part) => part.type === 'text');
    assert.ok(textPart, 'should have a text part');
    assert.ok(
      textPart.text.includes('<system-reminder>'),
      'text should contain system-reminder tag',
    );
    assert.ok(
      textPart.text.includes('Always explain your SQL'),
      'text should contain the reminder content',
    );

    const metadata = data.metadata;
    assert.ok(metadata, 'message should have metadata');
    assert.ok(
      typeof metadata === 'object' &&
        'reminders' in metadata &&
        Array.isArray(metadata.reminders),
      'metadata should have reminders array',
    );
    assert.strictEqual(
      metadata.reminders.length,
      1,
      'should have exactly one reminder',
    );
  });
});
