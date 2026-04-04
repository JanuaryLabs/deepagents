import {
  type StreamTextResult,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  generateId,
  isToolUIPart,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ChatAgentLike,
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  staticChatTitle,
} from '@deepagents/context';

const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
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

function createMockModelWithTitle(
  streamText = 'Hello from assistant',
  titleText = 'Generated Title',
) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [
        { type: 'text' as const, text: JSON.stringify({ title: titleText }) },
      ],
      finishReason: { unified: 'stop' as const, raw: '' },
      usage: testUsage,
      warnings: [],
    }),
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
      (entry: { name: string }) => entry.name === 'assistant',
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

    assert.deepStrictEqual(
      {
        names: secondChain.map((entry: { name: string }) => entry.name),
        assistantRole: (secondChain[1].data as UIMessage).role,
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
      (entry: { name: string }) => entry.name === 'assistant',
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

    assert.deepStrictEqual(
      secondChain.map((entry: { name: string }) => entry.name),
      ['user', 'assistant', 'user', 'assistant'],
    );

    const branches = await store.listBranches('test-chat');
    assert.strictEqual(branches.length, 1);
  });
});

describe('staticChatTitle()', () => {
  it('returns text from user message', () => {
    assert.strictEqual(
      staticChatTitle(userMessage('Hello world')),
      'Hello world',
    );
  });

  it('truncates to 100 chars with ellipsis', () => {
    const long = 'x'.repeat(150);
    assert.strictEqual(
      staticChatTitle(userMessage(long)),
      'x'.repeat(100) + '...',
    );
  });

  it('returns exact text when at 100 chars', () => {
    const exact = 'y'.repeat(100);
    assert.strictEqual(staticChatTitle(userMessage(exact)), exact);
  });

  it('returns New Chat when no text parts', () => {
    const msg: UIMessage = {
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
    assert.strictEqual(staticChatTitle(msg), 'New Chat');
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
    const chatAgent = agent({ name: 'assistant', context, model });

    const stream = await chat(chatAgent, [userMessage('help with python')], {
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
    const chatAgent = agent({ name: 'assistant', context, model });

    const stream = await chat(chatAgent, [userMessage('hello')]);
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
    const chatAgent = agent({ name: 'assistant', context, model });
    const longMessage = 'a'.repeat(150);

    const stream = await chat(chatAgent, [userMessage(longMessage)]);
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
    const chatAgent = agent({ name: 'assistant', context, model });

    const firstStream = await chat(chatAgent, [userMessage('first question')], {
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
      name: 'assistant',
      context,
      model: secondModel,
    });

    const secondStream = await chat(
      secondAgent,
      [
        userMessage('first question'),
        assistantMsg.data as UIMessage,
        userMessage('second question'),
      ],
      { generateTitle: true },
    );
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
    const chatAgent = agent({ name: 'assistant', context, model });

    const stream = await chat(chatAgent, [userMessage('test')], {
      generateTitle: true,
    });

    const reader = stream.getReader();
    const parts: unknown[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }

    const titlePart = parts.find(
      (p: any) => p?.type === 'data-chat-title',
    ) as any;
    assert.ok(titlePart, 'Stream should contain data-chat-title event');
    assert.deepStrictEqual(
      { type: titlePart.type, data: titlePart.data },
      { type: 'data-chat-title', data: 'Stream Title' },
    );
  });
});

function createChunkedStream(chunks: UIMessageChunk[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function createAbortMockAgent(
  context: ContextEngine,
  uiChunks: UIMessageChunk[],
): ChatAgentLike<Record<string, never>> {
  const model = createMockModel();
  return {
    context,
    model,
    stream: async () =>
      ({
        toUIMessageStream: () => createChunkedStream(uiChunks),
        totalUsage: Promise.resolve({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
      }) as unknown as StreamTextResult<ToolSet, never>,
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

    const stream = await chat(mockAgent, [userMessage('search')]);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-text-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantEntry = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    );
    assert.ok(assistantEntry, 'assistant message should be saved on abort');

    const assistantMsg = assistantEntry.data as UIMessage;
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

    const stream = await chat(mockAgent, [userMessage('search something')]);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-tool-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    )?.data as UIMessage;
    assert.ok(assistantMsg);

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

    const stream = await chat(mockAgent, [userMessage('search something')]);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-streaming-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    )?.data as UIMessage;
    assert.ok(assistantMsg);

    const toolParts = assistantMsg.parts.filter(isToolUIPart);
    assert.strictEqual(
      toolParts.length,
      0,
      'input-streaming tool parts should be removed on abort',
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

    const stream = await chat(mockAgent, [userMessage('do the thing')]);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-approval-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    )?.data as UIMessage;
    assert.ok(assistantMsg);

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

    const stream = await chat(mockAgent, [userMessage('lookup and search')]);
    await drain(stream);

    const branch = await store.getActiveBranch('abort-mixed-chat');
    assert.ok(branch?.headMessageId);
    const chain = await store.getMessageChain(branch.headMessageId);
    const assistantMsg = chain.find(
      (entry: { name: string }) => entry.name === 'assistant',
    )?.data as UIMessage;
    assert.ok(assistantMsg);

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
