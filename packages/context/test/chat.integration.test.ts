import { type UIMessage, generateId } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10 },
  outputTokens: { total: 5 },
} as const;

function createMockModel(text = 'Hello from assistant') {
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

function setup(mockText?: string) {
  const store = new InMemoryContextStore();
  const context = new ContextEngine({
    store,
    chatId: 'test-chat',
    userId: 'test-user',
  });
  const model = createMockModel(mockText);
  return { store, context, model };
}

describe('context chat()', () => {
  it('throws when messages array is empty', async () => {
    const { context, model } = setup();
    const chatAgent = agent({
      name: 'assistant',
      context,
      model,
    });
    await assert.rejects(() => chat(chatAgent, []));
  });

  it('saves user and assistant messages and tracks usage', async () => {
    const { store, context, model } = setup('First response');
    const firstUserMessage = userMessage('Hi there');
    const chatAgent = agent({
      name: 'assistant',
      context,
      model,
    });

    const stream = await chat(chatAgent, [firstUserMessage]);
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].name, 'user');
    assert.strictEqual(chain[1].name, 'assistant');

    const conversation = await store.getChat('test-chat');
    assert.ok(conversation?.metadata?.usage);
  });

  it('updates assistant message in place for tool-result style input', async () => {
    const { store, context, model } = setup('Updated response');
    const firstUserMessage = userMessage('How many users?');
    const chatAgent = agent({
      name: 'assistant',
      context,
      model,
    });

    const firstStream = await chat(chatAgent, [firstUserMessage]);
    await drain(firstStream);

    const firstBranch = await store.getActiveBranch('test-chat');
    assert.ok(firstBranch?.headMessageId);
    const firstChain = await store.getMessageChain(firstBranch.headMessageId);
    const persistedAssistant = firstChain.find(
      (entry) => entry.name === 'assistant',
    );
    assert.ok(persistedAssistant);

    const assistantUpdate: UIMessage = {
      id: persistedAssistant.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Tool returned extra details' }],
    };

    const secondStream = await chat(chatAgent, [
      firstUserMessage,
      assistantUpdate,
    ]);
    await drain(secondStream);

    const secondBranch = await store.getActiveBranch('test-chat');
    assert.ok(secondBranch?.headMessageId);
    const secondChain = await store.getMessageChain(secondBranch.headMessageId);

    assert.strictEqual(secondChain.length, 2);

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(branches.length, 1);
  });

  it('grows the chain across normal multiturn user messages', async () => {
    const { store, context, model } = setup('Next response');
    const chatAgent = agent({
      name: 'assistant',
      context,
      model,
    });

    const firstUserMessage = userMessage('Question one');
    const firstStream = await chat(chatAgent, [firstUserMessage]);
    await drain(firstStream);

    const firstBranch = await store.getActiveBranch('test-chat');
    assert.ok(firstBranch?.headMessageId);
    const firstChain = await store.getMessageChain(firstBranch.headMessageId);
    const firstAssistant = firstChain.find(
      (entry) => entry.name === 'assistant',
    );
    assert.ok(firstAssistant);

    const secondUserMessage = userMessage('Question two');
    const secondStream = await chat(chatAgent, [
      firstUserMessage,
      firstAssistant.data as UIMessage,
      secondUserMessage,
    ]);
    await drain(secondStream);

    const secondBranch = await store.getActiveBranch('test-chat');
    assert.ok(secondBranch?.headMessageId);
    const secondChain = await store.getMessageChain(secondBranch.headMessageId);

    assert.strictEqual(secondChain.length, 4);

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(branches.length, 1);
  });
});
