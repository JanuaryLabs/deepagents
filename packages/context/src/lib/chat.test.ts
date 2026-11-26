import {
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import {
  MockLanguageModelV4,
  convertReadableStreamToArray as drain,
} from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ChatAgentLike,
  ContextEngine,
  InMemoryContextStore,
  agent,
  assistant,
  chat,
} from '@deepagents/context';

import { buildSandbox } from '../../test/helpers/build-sandbox.ts';
import { requireUIMessage } from './ui-message-guards.ts';

const sandbox = await buildSandbox();

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;

function createMockModel(text = 'Hello from assistant') {
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

function createMockModelWithTitle(
  streamText = 'Hello from assistant',
  titleText = 'Generated Title',
) {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [
        { type: 'text' as const, text: JSON.stringify({ title: titleText }) },
      ],
      finishReason: { unified: 'stop' as const, raw: '' },
      usage: testUsage,
      warnings: [],
    },
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', delta: streamText },
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
  it('streams and persists native data parts without adding them to model input', async () => {
    const { context, model } = setup('Ready');
    const chatAgent = agent({ sandbox, name: 'assistant', context, model });
    await context.continue(userMessage('Hello'));
    const stream = await chat(chatAgent, {
      onStream(writer) {
        writer.write({
          type: 'data-progress',
          id: 'work',
          data: { status: 'started' },
        });
        writer.write({
          type: 'data-progress',
          id: 'work',
          data: { status: 'completed' },
        });
      },
    });
    const chunks = await Array.fromAsync(stream);
    assert.equal(chunks[0].type, 'start');
    assert.equal(chunks.filter((chunk) => chunk.type === 'start').length, 1);
    assert.equal(
      chunks.filter((chunk) => chunk.type === 'data-progress').length,
      2,
    );
    const messages = await context.getMessages();
    assert.partialDeepStrictEqual(messages.at(-1), {
      parts: [
        { type: 'data-progress', id: 'work', data: { status: 'completed' } },
      ],
    });
    await context.continue(userMessage('Continue'));
    await drain(await chat(chatAgent));
    assert.doesNotMatch(
      JSON.stringify(model.doStreamCalls.at(-1)?.prompt),
      /data-progress|completed/,
    );
  });

  it('saves user and assistant messages and tracks usage', async () => {
    const { store, context, model } = setup('First response');
    const firstUserMessage = userMessage('Hi there');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(firstUserMessage);
    const stream = await chat(chatAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('test-chat');
    assert.ok(branch?.headMessageId);

    const chain = await store.getMessageChain(branch.headMessageId);
    assert.deepStrictEqual(
      chain.map((entry: { name: string }) => entry.name),
      ['user', 'assistant'],
    );

    const conversation = await store.getChat('test-chat');
    assert.ok(conversation?.metadata?.usage);
  });

  it('updates assistant message in place for tool-result style input', async () => {
    const { store, context, model } = setup('Updated response');
    const firstUserMessage = userMessage('How many users?');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(firstUserMessage);
    const firstStream = await chat(chatAgent);
    await drain(firstStream);

    const firstBranch = await store.getActiveBranch('test-chat');
    assert.ok(firstBranch?.headMessageId);
    const firstChain = await store.getMessageChain(firstBranch.headMessageId);
    const persistedAssistant = firstChain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(persistedAssistant);

    const assistantUpdate: UIMessage = {
      id: persistedAssistant.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'Tool returned extra details' }],
    };

    await context.continue(assistantUpdate);
    const secondStream = await chat(chatAgent);
    await drain(secondStream);

    const secondBranch = await store.getActiveBranch('test-chat');
    assert.ok(secondBranch?.headMessageId);
    const secondChain = await store.getMessageChain(secondBranch.headMessageId);

    assert.deepStrictEqual(
      {
        names: secondChain.map((entry: { name: string }) => entry.name),
        assistantRole: requireUIMessage(
          secondChain[1].data,
          'second chain entry',
        ).role,
      },
      {
        names: ['user', 'assistant'],
        assistantRole: 'assistant',
      },
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(branches.length, 1);
  });

  it('grows the chain across normal multiturn user messages', async () => {
    const { store, context, model } = setup('Next response');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    const firstUserMessage = userMessage('Question one');
    await context.continue(firstUserMessage);
    const firstStream = await chat(chatAgent);
    await drain(firstStream);

    const firstBranch = await store.getActiveBranch('test-chat');
    assert.ok(firstBranch?.headMessageId);
    const firstChain = await store.getMessageChain(firstBranch.headMessageId);
    const firstAssistant = firstChain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(firstAssistant);

    const secondUserMessage = userMessage('Question two');
    await context.continue(secondUserMessage);
    const secondStream = await chat(chatAgent);
    await drain(secondStream);

    const secondBranch = await store.getActiveBranch('test-chat');
    assert.ok(secondBranch?.headMessageId);
    const secondChain = await store.getMessageChain(secondBranch.headMessageId);

    assert.deepStrictEqual(
      secondChain.map((entry: { name: string }) => entry.name),
      ['user', 'assistant', 'user', 'assistant'],
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(branches.length, 1);
  });
});

describe('chat() title generation', () => {
  it('generates and persists title on first message when generateTitle is true', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'title-chat',
      userId: 'test-user',
    });
    const model = createMockModelWithTitle('Response', 'Python Help');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('help with python'));
    const stream = await chat(chatAgent, {
      generateTitle: true,
    });
    await drain(stream);

    const chatData = await store.getChat('title-chat');
    assert.strictEqual(chatData?.title, 'Python Help');
  });

  it('sets default title from user message when generateTitle is false', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'no-title-chat',
      userId: 'test-user',
    });
    const model = createMockModel('Response');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('hello'));
    const stream = await chat(chatAgent);
    await drain(stream);

    const chatData = await store.getChat('no-title-chat');
    assert.strictEqual(chatData?.title, 'hello');
  });

  it('truncates default title to 100 chars', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'long-title-chat',
      userId: 'test-user',
    });
    const model = createMockModel('Response');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });
    const longMessage = 'a'.repeat(150);

    await context.continue(userMessage(longMessage));
    const stream = await chat(chatAgent);
    await drain(stream);

    const chatData = await store.getChat('long-title-chat');
    assert.strictEqual(chatData?.title, 'a'.repeat(100) + '...');
  });

  it('does not regenerate title on subsequent messages', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'multi-turn-chat',
      userId: 'test-user',
    });
    const model = createMockModelWithTitle('Response', 'First Title');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('first question'));
    const firstStream = await chat(chatAgent, {
      generateTitle: true,
    });
    await drain(firstStream);

    const firstChat = await store.getChat('multi-turn-chat');
    assert.strictEqual(firstChat?.title, 'First Title');

    const branch = await store.getActiveBranch('multi-turn-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find(
      (m: { name: string }) => m.name === 'assistant',
    );
    assert.ok(assistantMsg);

    const secondModel = createMockModelWithTitle(
      'Second response',
      'New Title',
    );
    const secondAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model: secondModel,
    });

    await context.continue(userMessage('second question'));
    const secondStream = await chat(secondAgent, {
      generateTitle: true,
    });
    await drain(secondStream);

    const secondChat = await store.getChat('multi-turn-chat');
    assert.strictEqual(secondChat?.title, 'First Title');
  });

  it('sends title via data stream event', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'stream-title-chat',
      userId: 'test-user',
    });
    const model = createMockModelWithTitle('Response', 'Stream Title');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('test'));
    const stream = await chat(chatAgent, {
      generateTitle: true,
    });

    const parts = await drain(stream);
    const titlePart = parts.find(
      (part): part is { type: 'data-chat-title'; data: string } =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'data-chat-title' &&
        'data' in part &&
        typeof part.data === 'string',
    );
    assert.ok(titlePart, 'Stream should contain data-chat-title event');
    assert.deepStrictEqual(
      { type: titlePart.type, data: titlePart.data },
      { type: 'data-chat-title', data: 'Stream Title' },
    );
  });

  it('does not leak a title-only assistant into the prompt when the first turn fails', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'failed-first-turn-chat',
      userId: 'test-user',
    });
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doGenerate: {
        content: [
          { type: 'text' as const, text: JSON.stringify({ title: 'Doomed' }) },
        ],
        finishReason: { unified: 'stop' as const, raw: '' },
        usage: testUsage,
        warnings: [],
      },
      doStream: async () => {
        throw new Error('model unavailable');
      },
    });
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('hello?'));
    const stream = await chat(chatAgent, {
      generateTitle: true,
    });
    await drain(stream);

    const messages = await context.getMessages();
    assert.deepStrictEqual(
      messages.map((message) => message.role),
      ['user'],
      `failed turn must not leak an assistant into the prompt: ${JSON.stringify(messages)}`,
    );
  });

  it('streams a plain Error as a generic message instead of {} or its internal text', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'masked-error-chat',
      userId: 'test-user',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('budget exceeded: secret internals');
      },
    });
    const chatAgent = agent({ sandbox, name: 'assistant', context, model });
    await context.continue(userMessage('hello?'));

    const chunks = await drain(await chat(chatAgent));

    assert.deepStrictEqual(
      chunks.flatMap((chunk) =>
        chunk.type === 'error' ? [chunk.errorText] : [],
      ),
      ['An error occurred.'],
    );
  });

  it('ends the stream normally after the error chunk when the model call fails', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'failed-turn-ends-cleanly-chat',
      userId: 'test-user',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('model unavailable');
      },
    });
    const chatAgent = agent({ sandbox, name: 'assistant', context, model });
    await context.continue(userMessage('hello?'));
    const stream = await chat(chatAgent);

    const chunks = await Array.fromAsync(stream);

    assert.deepStrictEqual(
      chunks.flatMap((chunk) =>
        chunk.type === 'error' ? [chunk.errorText] : [],
      ),
      ['An error occurred.'],
    );
  });

  it('lets onError turn a plain Error into the streamed error text', async () => {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: 'readable-error-chat',
      userId: 'test-user',
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('summarizer failed');
      },
    });
    const chatAgent = agent({ sandbox, name: 'assistant', context, model });
    await context.continue(userMessage('hello?'));

    const chunks = await drain(
      await chat(chatAgent, {
        onError: (error) =>
          Error.isError(error) ? error.message : 'not an Error',
      }),
    );

    assert.deepStrictEqual(
      chunks.flatMap((chunk) =>
        chunk.type === 'error' ? [chunk.errorText] : [],
      ),
      ['summarizer failed'],
    );
  });

  it('delivers the title only on the stream, never into the persisted chain', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'transient-title-chat',
      userId: 'test-user',
    });
    const model = createMockModelWithTitle('Response', 'Transient Title');
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('test'));
    const stream = await chat(chatAgent, {
      generateTitle: true,
    });
    await drain(stream);

    const branch = await store.getActiveBranch('transient-title-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const persistedAssistant = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(persistedAssistant);
    const { parts } = requireUIMessage(
      persistedAssistant.data,
      'persisted assistant',
    );
    assert.deepStrictEqual(
      parts.filter((part) => part.type === 'data-chat-title'),
      [],
      `title must not persist into the chain: ${JSON.stringify(parts)}`,
    );

    const conversation = await store.getChat('transient-title-chat');
    assert.strictEqual(conversation?.title, 'Transient Title');
  });
});

function createChunkedStream(
  chunks: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

const abortedUsage: LanguageModelUsage = {
  inputTokens: 10,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
  },
  outputTokens: 5,
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: 15,
};

function createAbortMockAgent(
  context: ContextEngine,
  uiChunks: UIMessageChunk[],
): ChatAgentLike<Record<string, never>> {
  const model = createMockModel();
  return {
    context,
    model,
    sandbox,
    stream: async () => ({
      toUIMessageStream: () => createChunkedStream(uiChunks),
      result: { usage: Promise.resolve(abortedUsage) },
    }),
  };
}

describe('chat() abort handling', () => {
  it('saves text message and tracks usage on abort', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'abort-text-chat',
      userId: 'test-user',
    });

    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Let me search for' },
      { type: 'text-end', id: 'text-1' },
      { type: 'abort' },
    ]);

    await context.continue(userMessage('search'));
    const stream = await chat(mockAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-text-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry, 'assistant message should be saved on abort');

    const assistantMsg = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    );
    const textPart = assistantMsg.parts.find(
      (p: { type: string }) => p.type === 'text',
    );
    assert.ok(textPart, 'text part should be preserved');

    const conversation = await store.getChat('abort-text-chat');
    assert.ok(
      conversation?.metadata?.usage,
      'usage should still be tracked on abort',
    );
  });

  it('converts input-available tool invocations to output-error on abort', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'abort-tool-chat',
      userId: 'test-user',
    });

    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'Searching...' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'tool-input-start',
        toolCallId: 'tc-1',
        toolName: 'search',
      },
      {
        type: 'tool-input-delta',
        toolCallId: 'tc-1',
        inputTextDelta: '{"query":"test"}',
      },
      {
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'search',
        input: { query: 'test' },
      },
      { type: 'abort' },
    ]);

    await context.continue(userMessage('search something'));
    const stream = await chat(mockAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-tool-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry);
    const assistantMsg = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    );

    const toolPart = assistantMsg.parts.find(isToolUIPart);
    assert.ok(toolPart, 'tool part should exist');
    assert.strictEqual(toolPart.state, 'output-error');
    assert.strictEqual(toolPart.errorText, 'Cancelled by user');
  });

  it('removes input-streaming tool parts on abort', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'abort-streaming-chat',
      userId: 'test-user',
    });

    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      {
        type: 'tool-input-start',
        toolCallId: 'tc-1',
        toolName: 'search',
      },
      {
        type: 'tool-input-delta',
        toolCallId: 'tc-1',
        inputTextDelta: '{"quer',
      },
      { type: 'abort' },
    ]);

    await context.continue(userMessage('search something'));
    const stream = await chat(mockAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-streaming-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry);
    const assistantMsg = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    );

    const toolParts = assistantMsg.parts.filter(isToolUIPart);
    assert.strictEqual(
      toolParts.length,
      0,
      'input-streaming tool parts should be removed on abort',
    );
  });

  it('saves a tool call whose input ended at the token limit as a failed call, not one that waits', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'length-streaming-chat',
      userId: 'test-user',
    });
    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      { type: 'tool-input-start', toolCallId: 'tc-1', toolName: 'search' },
      { type: 'tool-input-delta', toolCallId: 'tc-1', inputTextDelta: '{"q' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]);

    await context.continue(userMessage('search something'));
    await drain(await chat(mockAgent));

    const branch = await store.getActiveBranch('length-streaming-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry);
    const toolParts = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    ).parts.filter(isToolUIPart);
    assert.deepStrictEqual(
      toolParts.map(({ state, errorText }) => ({ state, errorText })),
      [
        {
          state: 'output-error',
          errorText: 'Tool input ended before the call was complete.',
        },
      ],
    );
  });

  it('converts approval-requested tool invocations to output-error on abort', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'abort-approval-chat',
      userId: 'test-user',
    });

    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      {
        type: 'tool-input-start',
        toolCallId: 'tc-1',
        toolName: 'dangerous-action',
      },
      {
        type: 'tool-input-delta',
        toolCallId: 'tc-1',
        inputTextDelta: '{"confirm":true}',
      },
      {
        type: 'tool-input-available',
        toolCallId: 'tc-1',
        toolName: 'dangerous-action',
        input: { confirm: true },
      },
      {
        type: 'tool-approval-request',
        toolCallId: 'tc-1',
        approvalId: 'approval-1',
      },
      { type: 'abort' },
    ]);

    await context.continue(userMessage('do the thing'));
    const stream = await chat(mockAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-approval-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry);
    const assistantMsg = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    );

    const toolPart = assistantMsg.parts.find(isToolUIPart);
    assert.ok(toolPart, 'tool part should exist');
    assert.strictEqual(toolPart.state, 'output-error');
    assert.strictEqual(toolPart.errorText, 'Cancelled by user');
  });

  it('preserves completed tool parts alongside sanitized ones on abort', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'abort-mixed-chat',
      userId: 'test-user',
    });

    const mockAgent = createAbortMockAgent(context, [
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
      {
        type: 'tool-input-start',
        toolCallId: 'tc-done',
        toolName: 'lookup',
      },
      {
        type: 'tool-input-delta',
        toolCallId: 'tc-done',
        inputTextDelta: '{"id":1}',
      },
      {
        type: 'tool-input-available',
        toolCallId: 'tc-done',
        toolName: 'lookup',
        input: { id: 1 },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'tc-done',
        output: { name: 'Alice' },
      },
      { type: 'finish-step' },
      { type: 'start-step' },
      {
        type: 'tool-input-start',
        toolCallId: 'tc-pending',
        toolName: 'search',
      },
      {
        type: 'tool-input-delta',
        toolCallId: 'tc-pending',
        inputTextDelta: '{"q":"test"}',
      },
      {
        type: 'tool-input-available',
        toolCallId: 'tc-pending',
        toolName: 'search',
        input: { q: 'test' },
      },
      { type: 'abort' },
    ]);

    await context.continue(userMessage('lookup and search'));
    const stream = await chat(mockAgent);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-mixed-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry);
    const assistantMsg = requireUIMessage(
      assistantEntry.data,
      'assistant entry',
    );

    const toolParts = assistantMsg.parts.filter(isToolUIPart);

    assert.strictEqual(toolParts.length, 2, 'both tool parts should exist');

    const completedTool = toolParts.find((p) => p.toolCallId === 'tc-done');
    assert.ok(completedTool);
    assert.strictEqual(completedTool.state, 'output-available');

    const pendingTool = toolParts.find((p) => p.toolCallId === 'tc-pending');
    assert.ok(pendingTool);
    assert.strictEqual(pendingTool.state, 'output-error');
    assert.strictEqual(pendingTool.errorText, 'Cancelled by user');
  });
});

describe('chat() abort signal integration', () => {
  it('aborts mid-stream via AbortController and persists the partial message', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'signal-abort-chat',
      userId: 'test-user',
    });

    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello' },
            { type: 'text-delta', id: 'text-1', delta: ' world' },
            { type: 'text-delta', id: 'text-1', delta: ' more' },
            { type: 'text-delta', id: 'text-1', delta: ' text' },
            { type: 'text-delta', id: 'text-1', delta: ' here' },
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

    const controller = new AbortController();
    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    let chunksSeen = 0;
    await context.continue(userMessage('test'));
    const stream = await chat(chatAgent, {
      abortSignal: controller.signal,
      transform: () =>
        new TransformStream({
          transform(chunk, ctrl) {
            ctrl.enqueue(chunk);
            if (++chunksSeen >= 3) controller.abort();
          },
        }),
    });

    await drain(stream).catch((error: unknown) => {
      // Aborting mid-stream rejects the drain with the signal's AbortError.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      throw error;
    });

    assert.ok(chunksSeen >= 3, 'at least 3 chunks should process before abort');

    const branch = await store.getActiveBranch('signal-abort-chat');
    assert.ok(
      branch?.headMessageId,
      'branch should exist after mid-stream abort',
    );
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(
      assistantEntry,
      'assistant message should be saved on mid-stream abort',
    );
  });

  it('completes without hanging when signal is pre-aborted', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'pre-abort-chat',
      userId: 'test-user',
    });

    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello' },
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

    const controller = new AbortController();
    controller.abort();

    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model,
    });

    await context.continue(userMessage('test'));
    try {
      const stream = await chat(chatAgent, {
        abortSignal: controller.signal,
        transform: () => new TransformStream(),
      });
      await drain(stream);
    } catch (error) {
      // A pre-aborted signal makes the AI SDK throw its AbortError.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }
    }

    const branch = await store.getActiveBranch('pre-abort-chat');
    assert.ok(branch?.headMessageId, 'user message should be persisted');
    const chain = await store.getMessageChain(branch.headMessageId);
    const names = chain.map((entry: { name: string }) => entry.name);
    assert.ok(names.includes('user'), 'user message should exist in chain');
  });
});

describe('convertToModelMessages strips incomplete tool calls', () => {
  it('filters input-available tool parts from messages sent to model', async () => {
    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: 'strip-tools-chat',
      userId: 'test-user',
    });

    const firstMsg = userMessage('call the search tool');

    const orphanToolCall = {
      type: 'tool-invocation',
      toolCallId: 'orphan-tc',
      toolName: 'search',
      state: 'input-available',
      input: { query: 'test' },
    } as const;
    const corruptAssistant: UIMessage = {
      id: generateId(),
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me search for that.' },
        orphanToolCall,
      ],
    };

    const chatAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model: createMockModel(),
    });

    await context.continue(firstMsg);
    const firstStream = await chat(chatAgent, {
      transform: () => new TransformStream(),
    });
    await drain(firstStream);

    context.set(assistant(corruptAssistant));
    await context.save({ branch: false });

    const capturingModel = new MockLanguageModelV4({
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

    const secondAgent = agent({
      sandbox,
      name: 'assistant',
      context,
      model: capturingModel,
    });

    await context.continue(userMessage('what did you find?'));
    const secondStream = await chat(secondAgent, {
      transform: () => new TransformStream(),
    });
    await drain(secondStream);

    const capturedPrompt = capturingModel.doStreamCalls[0].prompt;
    assert.ok(
      capturedPrompt.length > 0,
      'model should have been called with a non-empty prompt',
    );

    const hasOrphanedToolCall = capturedPrompt.some((msg) => {
      if (msg.role !== 'assistant') return false;
      return msg.content?.some(
        (part) => part.type === 'tool-call' && part.toolCallId === 'orphan-tc',
      );
    });

    assert.strictEqual(
      hasOrphanedToolCall,
      false,
      'input-available tool call should be stripped from model messages',
    );
  });
});
