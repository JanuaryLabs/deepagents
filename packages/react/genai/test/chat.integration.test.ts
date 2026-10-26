import {
  DefaultChatTransport,
  type UIMessage,
  type UIMessageChunk,
  createUIMessageStreamResponse,
  simulateReadableStream,
} from 'ai';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ComponentProps,
  StrictMode,
  act,
  createElement,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { z } from 'zod';

import {
  AgentProvider,
  ZukhrufChatTransport,
  useAgent,
  useAgentMessages,
  useChatManager,
} from '@deepagents/react-genai';

type ProviderProps = Omit<ComponentProps<typeof AgentProvider>, 'children'>;
type Controls = ReturnType<typeof useAgent> &
  ReturnType<typeof useAgentMessages> & {
    manager: ReturnType<typeof useChatManager>;
  };

async function mountChat(props: ProviderProps) {
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, globals);
  const root = createRoot(
    document.body.appendChild(document.createElement('div')),
  );
  let controls: Controls;
  function Observe() {
    const manager = useChatManager();
    const queue = useSyncExternalStore(manager.subscribe, () => manager.queue);
    controls = {
      ...useAgent(),
      ...useAgentMessages(),
      manager,
    };
    return createElement(
      'output',
      null,
      JSON.stringify({ messages: controls.messages, queue }),
    );
  }
  const render = async (next: ProviderProps) => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AgentProvider, {
            ...next,
            children: createElement(Observe),
          }),
        ),
      );
    });
  };
  const close = async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      await window.happyDOM.close();
      for (const key of Object.keys(globals)) {
        if (previous[key])
          Object.defineProperty(globalThis, key, previous[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  try {
    await render(props);
    return {
      get controls() {
        return controls;
      },
      render,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('native chat helpers preserve initial messages during server rendering', () => {
  function History() {
    const { messages } = useAgentMessages();
    return createElement(
      'output',
      null,
      messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
    );
  }
  const html = renderToString(
    createElement(AgentProvider, {
      chatId: 'server-render',
      transport: new ZukhrufChatTransport({
        api: 'https://unused.test/session',
      }),
      initialMessages: [
        {
          id: 'previous',
          role: 'user',
          parts: [{ type: 'text', text: 'earlier question' }],
        },
      ],
      onResetChat() {},
      children: createElement(History),
    }),
  );
  assert.equal(html, '<output>earlier question</output>');
});

test('disconnect holds queued sends until full replay replaces partial text', async () => {
  const first = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = first.writable.getWriter();
  const received = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const requests: Array<{ url: string; method: string }> = [];
  const sent: Array<{ message: { parts: Array<{ text: string }> } }> = [];
  const replay: UIMessageChunk[] = [
    { type: 'start', messageId: 'assistant-1' },
    { type: 'start-step' },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'Hello world' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET' });
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({
          ok: true,
          sessionId: 'replay',
          turnId: `turn-${sent.length}`,
        });
      }
      return createUIMessageStreamResponse({
        stream:
          requests.length === 2
            ? first.readable
            : simulateReadableStream({
                chunks:
                  sent.length === 1
                    ? replay
                    : [
                        { type: 'start', messageId: 'assistant-2' },
                        { type: 'finish', finishReason: 'stop' },
                      ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'replay',
    transport,
    onResetChat() {},
    onData: () => received.resolve(),
    onFinish: ({ isDisconnect }) => {
      if (isDisconnect) disconnected.resolve();
    },
  });
  try {
    await act(async () => {
      await Promise.all(
        ['hello', 'next'].map((prompt) =>
          view.controls.submit({ prompt, persistedPrompt: prompt }),
        ),
      );
    });
    assert.equal(sent.length, 1);
    await act(async () => {
      for (const chunk of replay.slice(0, 4)) {
        await writer.write(
          chunk.type === 'text-delta' ? { ...chunk, delta: 'Hello' } : chunk,
        );
      }
      await writer.write({
        type: 'data-received',
        data: true,
        transient: true,
      });
      await received.promise;
      await writer.abort(new TypeError('network error'));
      await disconnected.promise;
    });
    assert.equal(view.controls.status, 'error');
    assert.equal(sent.length, 1);
    assert.deepEqual(
      view.controls.manager.queue.map((m) => m.prompt),
      ['next'],
    );
    assert.deepEqual(
      view.controls.messages
        .at(-1)
        ?.parts.filter((p) => p.type === 'text')
        .map((p) => p.text),
      ['Hello'],
    );

    await act(async () => {
      await view.controls.resumeStream();
    });

    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(
      view.controls.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => ({
          id: m.id,
          texts: m.parts.filter((p) => p.type === 'text').map((p) => p.text),
        })),
      [
        { id: 'assistant-1', texts: ['Hello world'] },
        { id: 'assistant-2', texts: [] },
      ],
    );
    assert.deepEqual(
      sent.map((s) => s.message.parts[0].text),
      ['hello', 'next'],
    );
    assert.deepEqual(view.controls.manager.queue, []);
    assert.deepEqual(requests, [
      { url: 'https://chat.test/session/replay', method: 'POST' },
      { url: 'https://chat.test/session/replay/stream', method: 'GET' },
      { url: 'https://chat.test/session/replay/stream', method: 'GET' },
      { url: 'https://chat.test/session/replay', method: 'POST' },
      { url: 'https://chat.test/session/replay/stream', method: 'GET' },
    ]);
  } finally {
    await view.close();
    writer.releaseLock();
  }
});

test('resumption uses the latest transport and preserves explicit incremental semantics', async () => {
  const first = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = first.writable.getWriter();
  const received = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const uploadFile = async () => {
    throw new Error('No upload expected');
  };
  const initial = Object.assign(
    new DefaultChatTransport({
      api: 'https://chat.test/initial',
      fetch: async (_input, init) => {
        assert.equal(init?.method, 'POST');
        return createUIMessageStreamResponse({ stream: first.readable });
      },
    }),
    { uploadFile },
  );
  const requests: string[] = [];
  const latest = Object.assign(
    new DefaultChatTransport({
      api: 'https://chat.test/latest',
      resumeStreamIsReplay: false,
      fetch: async (input) => {
        requests.push(String(input));
        return createUIMessageStreamResponse({
          stream: simulateReadableStream({
            initialDelayInMs: null,
            chunkDelayInMs: null,
            chunks: [
              { type: 'start', messageId: 'assistant-1' },
              { type: 'text-delta', id: 'text-1', delta: ' world' },
              { type: 'text-end', id: 'text-1' },
              { type: 'data-received', data: true, transient: true },
              { type: 'finish', finishReason: 'stop' },
            ],
          }),
        });
      },
    }),
    { uploadFile },
  );
  const props = {
    chatId: 'incremental',
    transport: initial,
    onResetChat() {},
    onData: () => received.resolve(),
    onFinish: ({ isDisconnect }: { isDisconnect: boolean }) => {
      if (isDisconnect) disconnected.resolve();
    },
  };
  const view = await mountChat(props);
  try {
    await act(async () => {
      await view.controls.submit({ prompt: 'hello', persistedPrompt: 'hello' });
    });
    await act(async () => {
      await writer.write({ type: 'start', messageId: 'assistant-1' });
      await writer.write({ type: 'text-start', id: 'text-1' });
      await writer.write({ type: 'text-delta', id: 'text-1', delta: 'Hello' });
      await writer.write({
        type: 'data-received',
        data: true,
        transient: true,
      });
      await received.promise;
      await writer.abort(new TypeError('network error'));
      await disconnected.promise;
    });
    const callbacks: string[] = [];
    await view.render({
      ...props,
      transport: latest,
      onData: () => callbacks.push('data'),
      onFinish: () => callbacks.push('finish'),
    });

    await act(async () => {
      await view.controls.resumeStream();
    });

    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(
      view.controls.messages
        .at(-1)
        ?.parts.filter((p) => p.type === 'text')
        .map((p) => p.text),
      ['Hello world'],
    );
    assert.deepEqual(requests, ['https://chat.test/latest/incremental/stream']);
    assert.deepEqual(callbacks, ['data', 'finish']);
  } finally {
    await view.close();
    writer.releaseLock();
  }
});

test('two same-tick sends queue the second until the first response finishes', async () => {
  const first = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = first.writable.getWriter();
  const sent: Array<{ message: { parts: Array<{ text: string }> } }> = [];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (_input, init) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({
          ok: true,
          sessionId: 'queue',
          turnId: `turn-${sent.length}`,
        });
      }
      return createUIMessageStreamResponse({
        stream:
          sent.length === 1
            ? first.readable
            : simulateReadableStream({
                initialDelayInMs: null,
                chunkDelayInMs: null,
                chunks: [
                  { type: 'start', messageId: 'assistant-2' },
                  { type: 'text-start', id: 'text-2' },
                  {
                    type: 'text-delta',
                    id: 'text-2',
                    delta: 'Second response',
                  },
                  { type: 'text-end', id: 'text-2' },
                  { type: 'finish', finishReason: 'stop' },
                ],
              }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'queue',
    transport,
    onResetChat() {},
  });
  try {
    await act(async () => {
      const firstSend = view.controls.submit({
        prompt: 'first',
        persistedPrompt: 'first',
      });
      const secondSend = view.controls.submit({
        prompt: 'second',
        persistedPrompt: 'second',
      });
      await Promise.all([firstSend, secondSend]);
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(
      view.controls.manager.queue.map((m) => m.prompt),
      ['second'],
    );

    await act(async () => {
      await writer.write({ type: 'start', messageId: 'assistant-1' });
      await writer.write({ type: 'finish', finishReason: 'stop' });
      await writer.close();
    });

    assert.deepEqual(
      sent.map((request) => request.message.parts.map((p) => p.text).join('')),
      ['first', 'second'],
    );
    assert.deepEqual(view.controls.manager.queue, []);
    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(
      view.controls.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.parts),
      [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]],
    );
  } finally {
    await view.close();
    writer.releaseLock();
  }
});

test('a text submission cannot overtake an image upload and queues behind its turn', async () => {
  const upload = Promise.withResolvers<Response>();
  const first = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = first.writable.getWriter();
  const sent: Array<{
    message: { parts: Array<{ text: string }>; metadata?: unknown };
  }> = [];
  const receipt = {
    path: '/workspace/.uploads/shot.png',
    name: 'shot.png',
    mediaType: 'image/png',
    size: 4,
    url: 'https://chat.test/shot.png',
  };
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (input, init) => {
      if (String(input).endsWith('/uploads/uploads')) return upload.promise;
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({
          ok: true,
          sessionId: 'uploads',
          turnId: `turn-${sent.length}`,
        });
      }
      return createUIMessageStreamResponse({
        stream:
          sent.length === 1
            ? first.readable
            : simulateReadableStream({
                initialDelayInMs: null,
                chunkDelayInMs: null,
                chunks: [
                  { type: 'start', messageId: 'assistant-2' },
                  { type: 'finish', finishReason: 'stop' },
                ],
              }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'uploads',
    transport,
    onResetChat() {},
  });
  try {
    const image = view.controls.submit({
      prompt: 'look [Image #1]',
      persistedPrompt: 'look [Image #1]',
      files: [
        new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', {
          type: 'image/png',
        }),
      ],
    });
    const text = view.controls.submit({
      prompt: 'then explain',
      persistedPrompt: 'then explain',
    });
    assert.equal(sent.length, 0);

    await act(async () => {
      upload.resolve(Response.json(receipt));
      await Promise.all([image, text]);
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].message.metadata, { uploads: [receipt] });
    assert.deepEqual(
      view.controls.manager.queue.map((m) => m.prompt),
      ['then explain'],
    );

    await act(async () => {
      await writer.write({ type: 'start', messageId: 'assistant-1' });
      await writer.write({ type: 'finish', finishReason: 'stop' });
      await writer.close();
    });
    assert.deepEqual(
      sent.map((request) => request.message.parts.map((p) => p.text).join('')),
      ['look [Image #1]', 'then explain'],
    );
    assert.equal(view.controls.status, 'ready');
  } finally {
    await view.close();
    writer.releaseLock();
  }
});

test('a failed upload rejects its submission without blocking a following text send', async () => {
  const upload = Promise.withResolvers<Response>();
  const sent: Array<{ message: { parts: Array<{ text: string }> } }> = [];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (input, init) => {
      if (String(input).endsWith('/uploads')) return upload.promise;
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)));
        return Response.json({
          ok: true,
          sessionId: 'failure',
          turnId: 'turn-1',
        });
      }
      return createUIMessageStreamResponse({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'start', messageId: 'assistant-1' },
            { type: 'finish', finishReason: 'stop' },
          ],
        }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'failure',
    transport,
    onResetChat() {},
  });
  try {
    const image = view.controls.submit({
      prompt: 'look [Image #1]',
      persistedPrompt: 'look [Image #1]',
      files: [new File(['image'], 'shot.png', { type: 'image/png' })],
    });
    const rejected = assert.rejects(
      image,
      /Uploading shot.png failed with HTTP 503/,
    );
    const text = view.controls.submit({
      prompt: 'text survives',
      persistedPrompt: 'text survives',
    });

    await act(async () => {
      upload.resolve(new Response(null, { status: 503 }));
      await Promise.all([rejected, text]);
    });

    assert.deepEqual(
      sent.map((request) => request.message.parts.map((p) => p.text).join('')),
      ['text survives'],
    );
    assert.deepEqual(view.controls.manager.queue, []);
    assert.equal(view.controls.status, 'ready');
  } finally {
    await view.close();
  }
});

test('rapid sends with immediate responses drain in order without overlapping requests', async () => {
  const sent: string[] = [];
  let active = 0;
  let peak = 0;
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (_input, init) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)).message.parts[0].text);
        peak = Math.max(peak, ++active);
        return Response.json({
          ok: true,
          sessionId: 'rapid',
          turnId: `turn-${sent.length}`,
        });
      }
      return createUIMessageStreamResponse({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'start', messageId: `assistant-${sent.length}` },
            { type: 'finish', finishReason: 'stop' },
          ],
        }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'rapid',
    transport,
    onResetChat() {},
    onFinish() {
      active--;
    },
  });
  try {
    const prompts = Array.from({ length: 8 }, (_, i) => `message ${i}`);
    await act(async () => {
      await Promise.all(
        prompts.map((prompt) =>
          view.controls.submit({ prompt, persistedPrompt: prompt }),
        ),
      );
    });
    assert.deepEqual(sent, prompts);
    assert.equal(peak, 1);
    assert.equal(active, 0);
    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(view.controls.manager.queue, []);
    assert.equal(
      view.controls.messages.filter((m) => m.role === 'user').length,
      prompts.length,
    );
  } finally {
    await view.close();
  }
});

test('an explicit send after an error retries through the native SDK and drains FIFO', async () => {
  const sent: string[] = [];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (_input, init) => {
      if (init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)).message.parts[0].text);
        if (sent.length === 1)
          return new Response('temporarily unavailable', { status: 503 });
        return Response.json({
          ok: true,
          sessionId: 'retry',
          turnId: `turn-${sent.length}`,
        });
      }
      return createUIMessageStreamResponse({
        stream: simulateReadableStream({
          initialDelayInMs: null,
          chunkDelayInMs: null,
          chunks: [
            { type: 'start', messageId: `assistant-${sent.length}` },
            { type: 'finish', finishReason: 'stop' },
          ],
        }),
      });
    },
  });
  const view = await mountChat({
    chatId: 'retry',
    transport,
    onResetChat() {},
  });
  try {
    await act(async () => {
      await Promise.all(
        ['first', 'queued'].map((prompt) =>
          view.controls.submit({ prompt, persistedPrompt: prompt }),
        ),
      );
    });
    assert.equal(view.controls.status, 'error');
    assert.deepEqual(sent, ['first']);
    assert.deepEqual(
      view.controls.manager.queue.map((m) => m.prompt),
      ['queued'],
    );
    await act(async () => {
      await view.controls.submit({ prompt: 'retry', persistedPrompt: 'retry' });
    });
    assert.deepEqual(sent, ['first', 'queued', 'retry']);
    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(view.controls.manager.queue, []);
  } finally {
    await view.close();
  }
});

test('SDK ownership stops the old stream on chat changes and the current stream on unmount', async () => {
  const signals: AbortSignal[] = [];
  const requests: string[] = [];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/cancel')) return Response.json({ ok: true });
      if (init?.method === 'POST') {
        return Response.json({
          ok: true,
          sessionId: url.split('/').at(-1),
          turnId: 'turn-1',
        });
      }
      assert.ok(init?.signal);
      signals.push(init.signal);
      return createUIMessageStreamResponse({
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            init.signal?.addEventListener(
              'abort',
              () => controller.error(init.signal?.reason),
              { once: true },
            );
          },
        }),
      });
    },
  });
  const props = { chatId: 'first', transport, onResetChat() {} };
  const view = await mountChat(props);
  try {
    await act(async () => {
      await view.controls.submit({ prompt: 'first', persistedPrompt: 'first' });
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].aborted, false);
    await view.render({ ...props, chatId: 'second' });
    assert.equal(signals[0].aborted, true);
    assert.equal(view.controls.id, 'second');
    assert.deepEqual(view.controls.messages, []);
    await act(async () => {
      await view.controls.submit({
        prompt: 'second',
        persistedPrompt: 'second',
      });
    });
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false);
  } finally {
    await view.close();
  }
  assert.equal(signals[1].aborted, true);
  assert.deepEqual(
    requests.filter((url) => url.endsWith('/cancel')),
    [
      'https://chat.test/session/first/cancel',
      'https://chat.test/session/second/cancel',
    ],
  );
});

test('an upload finishing after a chat change rejects without sending to either chat', async () => {
  const upload = Promise.withResolvers<Response>();
  const requests: string[] = [];
  const transport = new ZukhrufChatTransport({
    api: 'https://chat.test/session',
    fetch: async (input) => {
      requests.push(String(input));
      return upload.promise;
    },
  });
  const props = { chatId: 'old', transport, onResetChat() {} };
  const view = await mountChat(props);
  try {
    const pending = view.controls.submit({
      prompt: 'look [Image #1]',
      persistedPrompt: 'look [Image #1]',
      files: [new File(['image'], 'shot.png', { type: 'image/png' })],
    });
    const rejected = assert.rejects(
      pending,
      /The chat changed before the submission was sent/,
    );
    await view.render({ ...props, chatId: 'new' });
    await act(async () => {
      upload.resolve(
        Response.json({
          path: '/workspace/.uploads/shot.png',
          name: 'shot.png',
          mediaType: 'image/png',
          size: 5,
          url: 'https://chat.test/shot.png',
        }),
      );
      await rejected;
    });
    assert.deepEqual(requests, ['https://chat.test/session/old/uploads']);
    assert.deepEqual(view.controls.messages, []);
    assert.deepEqual(view.controls.manager.queue, []);
  } finally {
    await view.close();
  }
});

test('native client-tool completion uses the latest registry and finishes before queued sends', async () => {
  const continuation = new TransformStream<UIMessageChunk, UIMessageChunk>();
  const writer = continuation.writable.getWriter();
  const sent: Array<{ messages: UIMessage[] }> = [];
  const transport = Object.assign(
    new DefaultChatTransport({
      api: 'https://chat.test/tools',
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return createUIMessageStreamResponse({
          stream:
            sent.length === 2
              ? continuation.readable
              : simulateReadableStream<UIMessageChunk>({
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                  chunks:
                    sent.length === 1
                      ? [
                          { type: 'start', messageId: 'rendered-tool' },
                          { type: 'start-step' },
                          {
                            type: 'tool-input-available',
                            toolCallId: 'chart-1',
                            toolName: 'renderChart',
                            input: {},
                          },
                          { type: 'finish-step' },
                          { type: 'finish', finishReason: 'tool-calls' },
                        ]
                      : [
                          { type: 'start', messageId: 'queued-response' },
                          { type: 'finish', finishReason: 'stop' },
                        ],
                }),
        });
      },
    }),
    {
      uploadFile: async () => {
        throw new Error('No upload expected');
      },
    },
  );
  const props = { chatId: 'tools', transport, onResetChat() {} };
  const view = await mountChat(props);
  try {
    await view.render({
      ...props,
      registry: {
        renderChart: {
          component: () => null,
          description: 'Render a chart',
          inputSchema: z.object({}),
          static: false,
        },
      },
    });
    await act(async () => {
      await Promise.all(
        ['chart', 'next'].map((prompt) =>
          view.controls.submit({ prompt, persistedPrompt: prompt }),
        ),
      );
    });
    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent[1].messages.at(-1)?.parts.find((p) => p.type === 'tool-renderChart'),
      {
        type: 'tool-renderChart',
        toolCallId: 'chart-1',
        state: 'output-available',
        input: {},
        output: 'rendered',
      },
    );
    assert.deepEqual(
      view.controls.manager.queue.map((m) => m.prompt),
      ['next'],
    );
    await act(async () => {
      await writer.write({ type: 'start', messageId: 'rendered-tool' });
      await writer.write({ type: 'start-step' });
      await writer.write({ type: 'text-start', id: 'summary' });
      await writer.write({
        type: 'text-delta',
        id: 'summary',
        delta: 'Chart rendered',
      });
      await writer.write({ type: 'text-end', id: 'summary' });
      await writer.write({ type: 'finish-step' });
      await writer.write({ type: 'finish', finishReason: 'stop' });
      await writer.close();
    });
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[2].messages.at(-1)?.parts, [
      { type: 'text', text: 'next' },
    ]);
    assert.equal(view.controls.status, 'ready');
    assert.deepEqual(view.controls.manager.queue, []);
  } finally {
    await view.close();
    writer.releaseLock();
  }
});
