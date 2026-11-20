import { createOpenAI } from '@ai-sdk/openai';
import {
  type UIMessage,
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  toUIMessageStream,
  tool,
} from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  ContextEngine,
  type ContextStore,
  InMemoryContextStore,
  XmlRenderer,
  assistant,
  user,
} from '@deepagents/context';

import { buildSandbox } from './helpers/build-sandbox.ts';

function newRequest(store: ContextStore) {
  return new ContextEngine({
    store,
    chatId: 'reasoning-dup',
    userId: 'test-user',
  });
}

const REUSED_ITEM_ID = 'rs_reused_across_a_client_tool_round_trip';

// Mirrors the real production shape (Limerence/Thea chat c329399c, openai:gpt-5.5):
// one OpenAI reasoning item spans a client-tool round-trip, so the streamed
// assistant message holds two reasoning parts that share the same openai.itemId,
// one per step. assistant() keeps both parts in the first step before it is stored.
function turnSpanningToolRoundTrip(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'reasoning',
        text: '',
        state: 'done',
        providerMetadata: {
          openai: { itemId: REUSED_ITEM_ID, reasoningEncryptedContent: null },
        },
      },
      {
        type: 'tool-readFile',
        toolCallId: 'call_readfile',
        state: 'output-available',
        input: { path: 'notes.txt' },
        output: 'file contents',
      },
      { type: 'step-start' },
      {
        type: 'reasoning',
        text: '',
        state: 'done',
        providerMetadata: {
          openai: { itemId: REUSED_ITEM_ID, reasoningEncryptedContent: null },
        },
      },
      { type: 'text', text: 'Here is the answer.' },
    ],
  };
}

describe('reasoning that spans a client-tool round-trip', () => {
  it('is normalised before storage so replay never sends a duplicate item id', async () => {
    const store = new InMemoryContextStore();

    const writer = newRequest(store);
    const assistantId = await writer.continue(
      user({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'read notes.txt' }],
      }),
    );
    await writer.continue(assistant(turnSpanningToolRoundTrip(assistantId)));

    // A later turn replays the persisted history from the store.
    const reader = newRequest(store);
    const { messages } = await reader.resolve({
      renderer: new XmlRenderer(),
      sandbox: await buildSandbox(),
    });

    const requests: Array<{ input: Array<{ type: string; id?: string }> }> = [];
    await streamText({
      model: createOpenAI({
        apiKey: 'fixture',
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return new Response(
            [
              {
                type: 'response.created',
                response: { id: 'resp_1', created_at: 0, model: 'gpt-6.1-sol' },
              },
              {
                type: 'response.completed',
                response: { usage: { input_tokens: 1, output_tokens: 1 } },
              },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      }).responses('gpt-6.1-sol'),
      messages: await convertToModelMessages(messages, {
        ignoreIncompleteToolCalls: true,
      }),
    }).consumeStream();

    assert.deepStrictEqual(
      requests[0]?.input.filter((item) => item.id === REUSED_ITEM_ID),
      [{ type: 'item_reference', id: REUSED_ITEM_ID }],
      'the reasoning item is sent exactly once; OpenAI rejects a duplicate with 400',
    );
  });
});

describe('an OpenAI reasoning item streamed with store: false', () => {
  it('keeps every summary and its encrypted reasoning through storage, and replays them as one item', async () => {
    const reasoningId = 'rs_two_summaries';
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_1', created_at: 0, model: 'gpt-6.1-sol' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningId, encrypted_content: null },
      },
      ...['First summary.', 'Second summary.'].flatMap((delta, index) => [
        {
          type: 'response.reasoning_summary_part.added',
          item_id: reasoningId,
          output_index: 0,
          summary_index: index,
        },
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: reasoningId,
          output_index: 0,
          summary_index: index,
          delta,
        },
        {
          type: 'response.reasoning_summary_part.done',
          item_id: reasoningId,
          output_index: 0,
          summary_index: index,
        },
      ]),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: reasoningId,
          encrypted_content: 'encrypted-reasoning',
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_1' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        delta: 'Answer.',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'message', id: 'msg_1' },
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const requests: Array<{ input: Array<{ type: string }> }> = [];
    const model = createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    }).responses('gpt-6.1-sol');
    const providerOptions = {
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    };
    let streamed: UIMessage | undefined;
    for await (const message of readUIMessageStream({
      stream: toUIMessageStream({
        stream: streamText({ model, prompt: 'think twice', providerOptions })
          .stream,
      }),
    })) {
      streamed = message;
    }
    assert.ok(streamed);
    const store = new InMemoryContextStore();
    const writer = newRequest(store);
    const assistantId = await writer.continue(
      user({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'think twice' }],
      }),
    );

    await writer.continue(assistant({ ...streamed, id: assistantId }));
    const { messages } = await newRequest(store).resolve({
      renderer: new XmlRenderer(),
      sandbox: await buildSandbox(),
    });
    requests.length = 0;
    await streamText({
      model,
      messages: await convertToModelMessages(messages),
      providerOptions,
    }).consumeStream();

    assert.deepStrictEqual(
      requests[0]?.input.filter((item) => item.type === 'reasoning'),
      [
        {
          type: 'reasoning',
          id: reasoningId,
          encrypted_content: 'encrypted-reasoning',
          summary: [
            { type: 'summary_text', text: 'First summary.' },
            { type: 'summary_text', text: 'Second summary.' },
          ],
        },
      ],
    );
  });
});

describe('an OpenAI reasoning item streamed with store: false across a tool round-trip', () => {
  it('keeps the summary and encrypted reasoning of its later step, and replays it as one item', async () => {
    const reasoningId = 'rs_spans_a_tool_call';
    const reasoningItem = (
      summaryIndex: number,
      text: string,
      encrypted: string | null,
    ) => [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: reasoningId, encrypted_content: null },
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: reasoningId,
        output_index: 0,
        summary_index: summaryIndex,
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: reasoningId,
        output_index: 0,
        summary_index: summaryIndex,
        delta: text,
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: reasoningId,
        output_index: 0,
        summary_index: summaryIndex,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: reasoningId,
          encrypted_content: encrypted,
        },
      },
    ];
    const lookupCall = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{}',
    };
    const created = {
      type: 'response.created',
      response: { id: 'resp_1', created_at: 0, model: 'gpt-6.1-sol' },
    };
    const completed = {
      type: 'response.completed',
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    };
    const steps = [
      [
        created,
        ...reasoningItem(0, 'Before the tool.', null),
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { ...lookupCall, status: 'in_progress' },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { ...lookupCall, status: 'completed' },
        },
        completed,
      ],
      [
        created,
        ...reasoningItem(1, 'After the tool.', 'encrypted-reasoning'),
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'msg_1' },
        },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 1,
          delta: 'Answer.',
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: 'msg_1' },
        },
        completed,
      ],
    ];
    const requests: Array<{ input: Array<{ type: string }> }> = [];
    const model = createOpenAI({
      apiKey: 'fixture',
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const events = steps[requests.length - 1] ?? [created, completed];
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    }).responses('gpt-6.1-sol');
    const providerOptions = {
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    };
    let streamed: UIMessage | undefined;
    const tools = {
      lookup: tool({
        inputSchema: z.object({}),
        execute: async () => 'found',
      }),
    };
    for await (const message of readUIMessageStream({
      stream: toUIMessageStream({
        stream: streamText({
          model,
          prompt: 'look it up',
          tools,
          stopWhen: stepCountIs(2),
          providerOptions,
        }).stream,
        tools,
      }),
    })) {
      streamed = message;
    }
    assert.ok(streamed);
    const store = new InMemoryContextStore();
    const writer = newRequest(store);
    const assistantId = await writer.continue(
      user({
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'look it up' }],
      }),
    );

    await writer.continue(assistant({ ...streamed, id: assistantId }));
    const { messages } = await newRequest(store).resolve({
      renderer: new XmlRenderer(),
      sandbox: await buildSandbox(),
    });
    requests.length = 0;
    await streamText({
      model,
      messages: await convertToModelMessages(messages),
      providerOptions,
    }).consumeStream();

    assert.deepStrictEqual(
      requests[0]?.input.filter((item) => item.type === 'reasoning'),
      [
        {
          type: 'reasoning',
          id: reasoningId,
          encrypted_content: 'encrypted-reasoning',
          summary: [
            { type: 'summary_text', text: 'Before the tool.' },
            { type: 'summary_text', text: 'After the tool.' },
          ],
        },
      ],
    );
  });
});
