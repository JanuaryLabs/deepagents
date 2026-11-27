import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { HttpResponse, http } from 'msw';
import { StrictMode, useState } from 'react';
import { expect, test, vi } from 'vitest';

import {
  AgentProvider,
  useAgent,
  useAgentMessages,
  useAgentMeta,
} from './agent-context.tsx';
import { persistedPromptOf } from './chat-manager.ts';
import { clearPrefill, readPrefill, writePrefill } from './prefill.ts';
import { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

type SendRequest = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];
type ReconnectRequest = Parameters<
  ChatTransport<UIMessage>['reconnectToStream']
>[0];

/**
 * The only stubbed seam: records every request the real `Chat` issues and
 * answers with an already-closed stream, so the status machine settles.
 */
class RecordingTransport implements ChatTransport<UIMessage> {
  readonly sends: SendRequest[] = [];
  readonly reconnects: ReconnectRequest[] = [];
  private readonly responses: UIMessageChunk[][];

  /** Each send answers with the next queued response; later sends answer empty. */
  constructor(responses: UIMessageChunk[][] = []) {
    this.responses = [...responses];
  }

  sendMessages: ChatTransport<UIMessage>['sendMessages'] = (request) => {
    this.sends.push(request);
    const chunks = this.responses.shift() ?? [];
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
  };

  reconnectToStream: ChatTransport<UIMessage>['reconnectToStream'] = (
    request,
  ) => {
    this.reconnects.push(request);
    return Promise.resolve(null);
  };

  uploadFile = async (sessionId: string, file: File) => ({
    path: `/workspace/.uploads/${sessionId}/${file.name}`,
    name: file.name,
    mediaType: 'image/png' as const,
    size: file.size,
    url: `https://uploads.test/${sessionId}/${file.name}`,
  });
}

class UploadingRecordingTransport extends RecordingTransport {
  readonly uploads: Array<{ sessionId: string; file: File }> = [];

  override uploadFile = async (sessionId: string, file: File) => {
    this.uploads.push({ sessionId, file });
    return {
      path: `/workspace/.uploads/${sessionId}/${file.name}`,
      name: file.name,
      mediaType: 'image/png' as const,
      size: file.size,
      url: `https://uploads.test/${sessionId}/${file.name}`,
    };
  };
}

function pngFile(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
    type: 'image/png',
  });
}

function FileSubmitHarness({ file }: { file: File }) {
  const { submit } = useAgent();
  const [failure, setFailure] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void submit({
            prompt: 'look [Image #1]',
            persistedPrompt: 'look [Image #1]',
            files: [file],
          }).catch((reason: unknown) => setFailure(String(reason)))
        }
      >
        Send image
      </button>
      <output>{failure}</output>
    </>
  );
}

function SubmitHarness() {
  const { submit } = useAgent();
  return (
    <button
      type="button"
      onClick={() => void submit({ prompt: 'hello', persistedPrompt: 'hello' })}
    >
      Send
    </button>
  );
}

/** Answers each send with a stream that stays open, and records its abort signal. */
class HeldOpenTransport extends RecordingTransport {
  override sendMessages: ChatTransport<UIMessage>['sendMessages'] = (
    request,
  ) => {
    this.sends.push(request);
    return Promise.resolve(new ReadableStream<UIMessageChunk>());
  };
}

/**
 * Answers each send with a stream that stays open until the test ends it:
 * `finish` closes the oldest open one, `fail` errors it, and an abort errors
 * it the way an aborted fetch does.
 */
class HeldStreamTransport extends RecordingTransport {
  private readonly open: ReadableStreamDefaultController<UIMessageChunk>[] = [];

  override sendMessages: ChatTransport<UIMessage>['sendMessages'] = (
    request,
  ) => {
    this.sends.push(request);
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          this.open.push(controller);
          request.abortSignal?.addEventListener(
            'abort',
            () => {
              this.open.splice(this.open.indexOf(controller), 1);
              controller.error(request.abortSignal?.reason);
            },
            { once: true },
          );
        },
      }),
    );
  };

  finish(): void {
    this.open.shift()?.close();
  }

  fail(): void {
    this.open.shift()?.enqueue({ type: 'error', errorText: 'model down' });
  }
}

function lastUserText(request: SendRequest): string {
  return textsOf(request.messages.filter((m) => m.role === 'user').slice(-1));
}

function Send({
  prompt,
  persistedPrompt = prompt,
}: {
  prompt: string;
  persistedPrompt?: string;
}) {
  const { submit } = useAgent();
  return (
    <button
      type="button"
      onClick={() => void submit({ prompt, persistedPrompt })}
    >
      Send {persistedPrompt}
    </button>
  );
}

/** Renders the queue strip a host builds: each queued message and its Remove control. */
function QueueProbe() {
  const {
    experimental_queuedMessages: queue,
    experimental_removeQueuedMessage,
    status,
  } = useAgentMessages();
  const { stop } = useAgent();
  return (
    <>
      <output aria-label="status">{status}</output>
      <output aria-label="queue">
        {queue.map((message) => persistedPromptOf(message)).join('|')}
      </output>
      {queue.map((message) => (
        <button
          key={message.id}
          type="button"
          onClick={() => experimental_removeQueuedMessage(message.id)}
        >
          Remove {persistedPromptOf(message)}
        </button>
      ))}
      <button type="button" onClick={stop}>
        Stop
      </button>
    </>
  );
}

function textsOf(messages: readonly UIMessage[]): string {
  return messages
    .map((message) =>
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    )
    .join('|');
}

/** Renders what a page reads from the provider: the initial-view flag and the messages. */
function ConversationProbe() {
  const { hasSubmitted } = useAgentMeta();
  const { messages } = useAgentMessages();
  const { clearChat, submit } = useAgent();
  return (
    <>
      <output aria-label="started">{String(hasSubmitted)}</output>
      <output aria-label="texts">{textsOf(messages)}</output>
      <button
        type="button"
        onClick={() =>
          void submit({ prompt: 'hello', persistedPrompt: 'hello' })
        }
      >
        Send
      </button>
      <button type="button" onClick={clearChat}>
        Clear
      </button>
    </>
  );
}

const greeting: UIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'earlier question' }],
};

test('submissions go through the injected transport with the caller-controlled chatId', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-1"
        transport={transport}
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    const [request] = transport.sends;
    expect(request.chatId).toBe('chat-1');
    expect(request.trigger).toBe('submit-message');
    expect(request.messages[request.messages.length - 1]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(transport.reconnects).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test('resume reconnects through the injected transport once on mount', async () => {
  const transport = new RecordingTransport();

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-9"
        transport={transport}
        resume
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await vi.waitFor(() => {
      expect(transport.reconnects).toHaveLength(1);
    });
    expect(transport.reconnects[0].chatId).toBe('chat-9');

    rerender(
      <AgentProvider
        chatId="chat-9"
        transport={transport}
        resume
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );
    expect(transport.reconnects).toHaveLength(1);
    expect(transport.sends).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test('forwards data and finish callbacks from the chat', async () => {
  const user = userEvent.setup();
  const onData = vi.fn();
  const onFinish = vi.fn();
  const transport = new RecordingTransport([
    [
      { type: 'data-probe', data: { hit: 1 }, transient: true },
      { type: 'data-probe', id: 'p2', data: { hit: 2 } },
    ],
  ]);

  try {
    render(
      <AgentProvider
        chatId="chat-1"
        transport={transport}
        onData={onData}
        onFinish={onFinish}
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onFinish).toHaveBeenCalledOnce();
    });
    expect(onData).toHaveBeenNthCalledWith(1, {
      type: 'data-probe',
      data: { hit: 1 },
      transient: true,
    });
    expect(onData).toHaveBeenNthCalledWith(2, {
      type: 'data-probe',
      id: 'p2',
      data: { hit: 2 },
    });
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isError: false }),
    );
  } finally {
    cleanup();
  }
});

test('uploads submission files through a transport that can store them', async () => {
  const user = userEvent.setup();
  const transport = new UploadingRecordingTransport();
  const file = pngFile();

  try {
    render(
      <AgentProvider
        chatId="chat-up"
        transport={transport}
        onResetChat={() => {}}
      >
        <FileSubmitHarness file={file} />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send image'));

    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0].sessionId).toBe('chat-up');
    expect(transport.uploads[0].file).toBe(file);
    const [request] = transport.sends;
    expect(request.messages[request.messages.length - 1]).toMatchObject({
      parts: [{ type: 'text', text: 'look [Image #1]' }],
      metadata: {
        uploads: [
          {
            path: '/workspace/.uploads/chat-up/shot.png',
            name: 'shot.png',
            mediaType: 'image/png',
            size: 4,
            url: 'https://uploads.test/chat-up/shot.png',
          },
        ],
      },
    });
  } finally {
    cleanup();
  }
});

test('shows initialMessages and reports the conversation as started on mount', () => {
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-seeded"
        transport={transport}
        initialMessages={[greeting]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe('earlier question');
    expect(screen.getByLabelText('started').textContent).toBe('true');
  } finally {
    cleanup();
  }
});

test('reports the conversation as started after a submit, and not after clearChat', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-fresh"
        transport={transport}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    expect(screen.getByLabelText('started').textContent).toBe('false');

    await user.click(screen.getByText('Send'));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('started').textContent).toBe('true');
    });

    await user.click(screen.getByText('Clear'));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('started').textContent).toBe('false');
    });
  } finally {
    cleanup();
  }
});

test('skipInitialView reports the conversation as started with no messages', () => {
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-skip"
        transport={transport}
        skipInitialView
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe('');
    expect(screen.getByLabelText('started').textContent).toBe('true');
  } finally {
    cleanup();
  }
});

test('a new chatId starts a chat seeded with the initialMessages of that render', () => {
  const transport = new RecordingTransport();
  const other: UIMessage = {
    id: 'u2',
    role: 'user',
    parts: [{ type: 'text', text: 'other conversation' }],
  };

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-a"
        transport={transport}
        initialMessages={[greeting]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    rerender(
      <AgentProvider
        chatId="chat-b"
        transport={transport}
        initialMessages={[other]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe(
      'other conversation',
    );
  } finally {
    cleanup();
  }
});

test('unmount stops the stream in flight', async () => {
  const user = userEvent.setup();
  const transport = new HeldOpenTransport();

  try {
    const { unmount } = render(
      <AgentProvider
        chatId="chat-stream"
        transport={transport}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    await user.click(screen.getByText('Send'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    const [request] = transport.sends;
    expect(request.abortSignal?.aborted).toBe(false);

    unmount();

    expect(request.abortSignal?.aborted).toBe(true);
  } finally {
    cleanup();
  }
});

test('stop holds the queued message until the next submit, which sends it first', async () => {
  const user = userEvent.setup();
  const transport = new HeldStreamTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-hold"
        transport={transport}
        onResetChat={() => {}}
      >
        <QueueProbe />
        <Send prompt="primer" />
        <Send prompt="queued" />
        <Send prompt="next" />
      </AgentProvider>,
    );
    await user.click(screen.getByText('Send primer'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    await user.click(screen.getByText('Send queued'));

    await user.click(screen.getByText('Stop'));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('ready');
    });

    expect(transport.sends).toHaveLength(1);
    expect(screen.getByLabelText('queue').textContent).toBe('queued');

    await user.click(screen.getByText('Send next'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(2);
    });
    expect(lastUserText(transport.sends[1])).toBe('queued');
    expect(screen.getByLabelText('queue').textContent).toBe('next');
  } finally {
    cleanup();
  }
});

test('a failed response holds the queued message', async () => {
  const user = userEvent.setup();
  const transport = new HeldStreamTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-error"
        transport={transport}
        onResetChat={() => {}}
      >
        <QueueProbe />
        <Send prompt="primer" />
        <Send prompt="queued" />
        <Send prompt="next" />
      </AgentProvider>,
    );
    await user.click(screen.getByText('Send primer'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    await user.click(screen.getByText('Send queued'));

    await act(async () => {
      transport.fail();
    });
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    await act(async () => {});

    expect(transport.sends).toHaveLength(1);
    expect(screen.getByLabelText('queue').textContent).toBe('queued');

    await user.click(screen.getByText('Send next'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(2);
    });
    expect(lastUserText(transport.sends[1])).toBe('queued');
    expect(screen.getByLabelText('queue').textContent).toBe('next');
  } finally {
    cleanup();
  }
});

test('the queue lists each message as the user typed it, and a removed one is never sent', async () => {
  const user = userEvent.setup();
  const transport = new HeldStreamTransport();
  const expanded = 'List the latest conversations.\n\nfrom today';

  try {
    render(
      <AgentProvider
        chatId="chat-queue-view"
        transport={transport}
        onResetChat={() => {}}
      >
        <QueueProbe />
        <Send prompt="primer" />
        <Send prompt={expanded} persistedPrompt="/prompts:recent from today" />
        <Send prompt="kept" />
      </AgentProvider>,
    );
    await user.click(screen.getByText('Send primer'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    await user.click(screen.getByText('Send /prompts:recent from today'));
    await user.click(screen.getByText('Send kept'));

    expect(screen.getByLabelText('queue').textContent).toBe(
      '/prompts:recent from today|kept',
    );

    await user.click(screen.getByText('Remove /prompts:recent from today'));
    expect(screen.getByLabelText('queue').textContent).toBe('kept');

    await act(async () => {
      transport.finish();
    });
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(2);
    });
    expect(lastUserText(transport.sends[1])).toBe('kept');
    expect(screen.getByLabelText('queue').textContent).toBe('');
    expect(
      transport.sends[1].messages.map((message) => textsOf([message])),
    ).not.toContain(expanded);
  } finally {
    cleanup();
  }
});

test('sends through the transport given on the latest render', async () => {
  const user = userEvent.setup();
  const first = new RecordingTransport();
  const latest = new RecordingTransport();

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-swap"
        transport={first}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    rerender(
      <AgentProvider
        chatId="chat-swap"
        transport={latest}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(latest.sends).toHaveLength(1);
    });
    expect(first.sends).toHaveLength(0);
  } finally {
    cleanup();
  }
});

function MessagesProbe() {
  const { messages } = useAgentMessages();
  return (
    <ol>
      {messages.map((message) => (
        <li key={message.id} data-role={message.role}>
          {message.parts
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('')}
        </li>
      ))}
    </ol>
  );
}

test('under StrictMode a pending prefill is sent once and its answer arrives (#5918)', async () => {
  const transport = new RecordingTransport([
    [
      { type: 'start' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'The answer.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ],
  ]);
  writePrefill({ prompt: 'first question', targetChatId: 'chat-strict' });

  try {
    render(
      <StrictMode>
        <AgentProvider
          chatId="chat-strict"
          transport={transport}
          onResetChat={() => {}}
        >
          <MessagesProbe />
        </AgentProvider>
      </StrictMode>,
    );

    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });
    expect({
      sends: transport.sends.length,
      aborted: transport.sends.filter((send) => send.abortSignal?.aborted)
        .length,
      questions: screen.getAllByText('first question').length,
    }).toEqual({ sends: 1, aborted: 0, questions: 1 });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a provider that unmounts before its deferred send sends nothing and keeps the prefill for the next mount (#5918)', async () => {
  const transport = new RecordingTransport();
  writePrefill({ prompt: 'first question', targetChatId: 'chat-gone' });

  try {
    const { unmount } = render(
      <AgentProvider
        chatId="chat-gone"
        transport={transport}
        onResetChat={() => {}}
      >
        <MessagesProbe />
      </AgentProvider>,
    );
    unmount();
    await Promise.resolve();

    expect({
      sends: transport.sends.length,
      pending: readPrefill()?.prompt,
    }).toEqual({ sends: 0, pending: 'first question' });
  } finally {
    clearPrefill();
    cleanup();
  }
});

const msw = new Msw();
/** Same origin as the page, as a host mounts Zukhruf: a cross-origin POST would add a CORS preflight. */
const zukhrufApi = new URL('/zukhruf/v1/session', location.href).href;

/** The questions the chat POSTed to start a turn, in order. */
async function postedQuestions(requests: readonly Request[]) {
  const turns = requests.filter(
    (request) => request.method === 'POST' && !request.url.endsWith('/cancel'),
  );
  return Promise.all(
    turns.map(async (request) => {
      const body: { message: UIMessage } = await request.clone().json();
      return textsOf([body.message]);
    }),
  );
}

function StatusProbe() {
  const { status } = useAgentMessages();
  return <output aria-label="status">{status}</output>;
}

function ZukhrufPage({ chatId }: { chatId: string }) {
  return (
    <AgentProvider
      chatId={chatId}
      transport={new ZukhrufChatTransport({ api: zukhrufApi })}
      onResetChat={() => {}}
    >
      <StatusProbe />
      <MessagesProbe />
    </AgentProvider>
  );
}

/** Zukhruf's stream of every accepted turn: one text part, 'The answer.' */
function answeringStream() {
  return http.get(
    `${zukhrufApi}/:sessionId/stream`,
    () =>
      new HttpResponse(
        [
          { type: 'start' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'The answer.' },
          { type: 'text-end', id: 't1' },
          { type: 'finish' },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        {
          headers: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        },
      ),
  );
}

test('a prefill whose first POST fails is sent again after a reload (#6146)', async () => {
  const chatId = 'chat-reload-after-500';
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, () =>
      HttpResponse.json({ error: 'down' }, { status: 500 }),
    ),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    expect(await postedQuestions(interception.requests)).toEqual([
      'first question',
    ]);
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);

    await vi.waitFor(async () => {
      expect(await postedQuestions(interception.requests)).toEqual([
        'first question',
        'first question',
      ]);
    });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill whose POST is accepted is not sent again after a reload (#6146)', async () => {
  const chatId = 'chat-reload-after-202';
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, ({ params }) =>
      HttpResponse.json(
        { ok: true, sessionId: params.sessionId, turnId: 'turn-1' },
        { status: 202 },
      ),
    ),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
    answeringStream(),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);
    await act(async () => {});

    expect({
      questions: await postedQuestions(interception.requests),
      pending: readPrefill(),
    }).toEqual({ questions: ['first question'], pending: null });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill whose POST fails on the network is sent again after a reload (#6146)', async () => {
  const chatId = 'chat-reload-after-network-error';
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, () => HttpResponse.error()),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);

    await vi.waitFor(async () => {
      expect(await postedQuestions(interception.requests)).toEqual([
        'first question',
        'first question',
      ]);
    });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill is sent under the same message id on every attempt, so Zukhruf derives the same turn id (#6146)', async () => {
  const chatId = 'chat-same-message-id';
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, () =>
      HttpResponse.json({ error: 'down' }, { status: 500 }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });
  const stored = readPrefill();

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    first.unmount();
    render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(interception.requests).toHaveLength(2);
    });

    const messageIds = await Promise.all(
      interception.requests.map(async (request) => {
        const body: { message: UIMessage } = await request.clone().json();
        return body.message.id;
      }),
    );
    expect(messageIds).toEqual([stored?.messageId, stored?.messageId]);
  } finally {
    clearPrefill();
    cleanup();
  }
});

function StopButton() {
  const { stop } = useAgent();
  return (
    <button type="button" onClick={stop}>
      Stop
    </button>
  );
}

/** Answers the first POST only when its request is aborted or the test releases it, and every later POST with a 500. */
function heldFirstPost() {
  const released = Promise.withResolvers<void>();
  let posts = 0;
  return {
    release: () => released.resolve(),
    handler: http.post(`${zukhrufApi}/:sessionId`, async ({ request }) => {
      posts += 1;
      if (posts > 1)
        return HttpResponse.json({ error: 'down' }, { status: 500 });
      await Promise.race([
        released.promise,
        new Promise((resolve) =>
          request.signal.addEventListener('abort', resolve, { once: true }),
        ),
      ]);
      return HttpResponse.error();
    }),
  };
}

test('a prefill the user stops before Zukhruf answers is cleared and not sent after a reload (#6146)', async () => {
  const chatId = 'chat-reload-after-stop';
  const user = userEvent.setup();
  const firstPost = heldFirstPost();
  await using interception = msw.intercept(
    firstPost.handler,
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <StatusProbe />
        <StopButton />
      </AgentProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('submitted');
    });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('ready');
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);
    await act(async () => {});

    expect({
      questions: await postedQuestions(interception.requests),
      pending: readPrefill(),
    }).toEqual({ questions: ['first question'], pending: null });
  } finally {
    firstPost.release();
    clearPrefill();
    cleanup();
  }
});

test('a prefill whose page unmounts before Zukhruf answers is sent again on the next mount (#6146)', async () => {
  const chatId = 'chat-remount-while-pending';
  const firstPost = heldFirstPost();
  await using interception = msw.intercept(
    firstPost.handler,
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(async () => {
      expect(await postedQuestions(interception.requests)).toEqual([
        'first question',
      ]);
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);

    await vi.waitFor(async () => {
      expect(await postedQuestions(interception.requests)).toEqual([
        'first question',
        'first question',
      ]);
    });
  } finally {
    firstPost.release();
    clearPrefill();
    cleanup();
  }
});

function RetryButton() {
  const { regenerate } = useAgentMessages();
  return (
    <button type="button" onClick={() => void regenerate()}>
      Retry
    </button>
  );
}

test('a prefill whose failed POST is retried and accepted is not sent again after a reload (#6146)', async () => {
  const chatId = 'chat-reload-after-retry';
  const user = userEvent.setup();
  let posts = 0;
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, ({ params }) => {
      posts += 1;
      return posts === 1
        ? HttpResponse.json({ error: 'down' }, { status: 500 })
        : HttpResponse.json(
            { ok: true, sessionId: params.sessionId, turnId: 'turn-1' },
            { status: 202 },
          );
    }),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
    answeringStream(),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <StatusProbe />
        <MessagesProbe />
        <RetryButton />
      </AgentProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);
    await act(async () => {});

    expect({
      questions: await postedQuestions(interception.requests),
      pending: readPrefill(),
    }).toEqual({
      questions: ['first question', 'first question'],
      pending: null,
    });
  } finally {
    clearPrefill();
    cleanup();
  }
});

function NewChatButton() {
  const { resetChat } = useAgent();
  return (
    <button type="button" onClick={() => resetChat('second question')}>
      New chat
    </button>
  );
}

test('a prefill accepted after the user starts a new chat with a question leaves the new chat its prefill (#6146)', async () => {
  const chatId = 'chat-accepted-after-new-chat';
  const user = userEvent.setup();
  const answer = Promise.withResolvers<void>();
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, async ({ params }) => {
      await answer.promise;
      return HttpResponse.json(
        { ok: true, sessionId: params.sessionId, turnId: 'turn-1' },
        { status: 202 },
      );
    }),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
    http.get(
      `${zukhrufApi}/:sessionId/stream`,
      () =>
        new HttpResponse('data: [DONE]\n\n', {
          headers: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        }),
    ),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    render(
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <StatusProbe />
        <NewChatButton />
      </AgentProvider>,
    );
    await vi.waitFor(async () => {
      expect(await postedQuestions(interception.requests)).toEqual([
        'first question',
      ]);
    });
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    answer.resolve();
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('ready');
    });

    expect(readPrefill()?.prompt).toBe('second question');
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill whose POST failed is cleared once a newer question in the chat is accepted (#6146)', async () => {
  const chatId = 'chat-newer-question-accepted';
  const user = userEvent.setup();
  let posts = 0;
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, ({ params }) => {
      posts += 1;
      return posts === 1
        ? HttpResponse.json({ error: 'down' }, { status: 500 })
        : HttpResponse.json(
            { ok: true, sessionId: params.sessionId, turnId: 'turn-2' },
            { status: 202 },
          );
    }),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
    answeringStream(),
  );
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const first = render(
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <StatusProbe />
        <MessagesProbe />
        <SubmitHarness />
      </AgentProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);
    await act(async () => {});

    expect({
      questions: await postedQuestions(interception.requests),
      pending: readPrefill(),
    }).toEqual({ questions: ['first question', 'hello'], pending: null });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill sent into a chat that already has history is not sent again after a reload (#6146)', async () => {
  const chatId = 'chat-prefill-after-history';
  await using interception = msw.intercept(
    http.post(`${zukhrufApi}/:sessionId`, ({ params }) =>
      HttpResponse.json(
        { ok: true, sessionId: params.sessionId, turnId: 'turn-2' },
        { status: 202 },
      ),
    ),
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
    answeringStream(),
  );
  const history: UIMessage[] = [
    {
      id: 'earlier-question',
      role: 'user',
      parts: [{ type: 'text', text: 'earlier question' }],
      metadata: { persistedPrompt: 'earlier question' },
    },
    {
      id: 'earlier-answer',
      role: 'assistant',
      parts: [{ type: 'text', text: 'earlier answer' }],
    },
  ];
  writePrefill({ prompt: 'first question', targetChatId: chatId });

  try {
    const page = () => (
      <AgentProvider
        chatId={chatId}
        initialMessages={history}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <MessagesProbe />
      </AgentProvider>
    );
    const first = render(page());
    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });
    first.unmount();

    render(page());
    await act(async () => {});

    expect({
      questions: await postedQuestions(interception.requests),
      pending: readPrefill(),
    }).toEqual({ questions: ['first question'], pending: null });
  } finally {
    clearPrefill();
    cleanup();
  }
});

/** Zukhruf's upload route: stores the file under the session and answers its receipt. */
function uploadRoute() {
  return http.post(
    `${zukhrufApi}/:sessionId/uploads`,
    async ({ params, request }) => {
      const name = decodeURIComponent(
        request.headers.get('x-upload-filename') ?? '',
      );
      const sessionId = String(params.sessionId);
      return HttpResponse.json(
        {
          path: `/workspace/.uploads/${sessionId}/${name}`,
          name,
          mediaType: request.headers.get('content-type'),
          size: (await request.arrayBuffer()).byteLength,
          url: `https://uploads.test/${sessionId}/${name}`,
        },
        { status: 201 },
      );
    },
  );
}

/** What a host's entry page does: upload under the minted chat id, then write the prefill with the receipts. */
async function writePrefillWithImage(chatId: string) {
  const transport = new ZukhrufChatTransport({ api: zukhrufApi });
  const file = new File(['lab'], 'lab.png', { type: 'image/png' });
  const receipt = await transport.uploadFile(chatId, file);
  writePrefill({
    prompt: 'what does [Image #1] show?',
    targetChatId: chatId,
    uploads: [receipt],
  });
  return receipt;
}

/** The user messages the chat POSTed to start a turn, in order. */
async function postedTurnMessages(requests: readonly Request[]) {
  const turns = requests.filter(
    (request) =>
      request.method === 'POST' &&
      !request.url.endsWith('/cancel') &&
      !request.url.endsWith('/uploads'),
  );
  return Promise.all(
    turns.map(async (request) => {
      const body: {
        message: UIMessage<{ uploads?: unknown; persistedPrompt: string }>;
      } = await request.clone().json();
      return body.message;
    }),
  );
}

function uploadRequests(requests: readonly Request[]) {
  return requests.filter((request) => request.url.endsWith('/uploads'));
}

test('a prefill written with uploads starts the chat with a message whose metadata.uploads lists them (#6199)', async () => {
  const chatId = 'chat-prefill-uploads';
  await using interception = msw.intercept(
    uploadRoute(),
    http.post(`${zukhrufApi}/:sessionId`, ({ params }) =>
      HttpResponse.json(
        { ok: true, sessionId: params.sessionId, turnId: 'turn-1' },
        { status: 202 },
      ),
    ),
    answeringStream(),
  );
  const receipt = await writePrefillWithImage(chatId);

  try {
    render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByText('The answer.')).toBeInTheDocument();
    });

    const [message] = await postedTurnMessages(interception.requests);
    expect({
      receipt,
      message: { parts: message.parts, metadata: message.metadata },
    }).toEqual({
      receipt: {
        path: `/workspace/.uploads/${chatId}/lab.png`,
        name: 'lab.png',
        mediaType: 'image/png',
        size: 3,
        url: `https://uploads.test/${chatId}/lab.png`,
      },
      message: {
        parts: [{ type: 'text', text: 'what does [Image #1] show?' }],
        metadata: {
          uploads: [receipt],
          persistedPrompt: 'what does [Image #1] show?',
        },
      },
    });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill with uploads whose first POST fails is sent again under the same message id with the same uploads, and no file is uploaded again (#6199)', async () => {
  const chatId = 'chat-prefill-uploads-retry';
  await using interception = msw.intercept(
    uploadRoute(),
    http.post(`${zukhrufApi}/:sessionId`, () =>
      HttpResponse.json({ error: 'down' }, { status: 500 }),
    ),
  );
  const receipt = await writePrefillWithImage(chatId);
  const stored = readPrefill();

  try {
    const first = render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('error');
    });
    first.unmount();
    render(<ZukhrufPage chatId={chatId} />);
    await vi.waitFor(async () => {
      expect(await postedTurnMessages(interception.requests)).toHaveLength(2);
    });

    const attempts = await postedTurnMessages(interception.requests);
    expect({
      attempts: attempts.map((message) => ({
        id: message.id,
        uploads: message.metadata?.uploads,
      })),
      uploads: uploadRequests(interception.requests).length,
    }).toEqual({
      attempts: [
        { id: stored?.messageId, uploads: [receipt] },
        { id: stored?.messageId, uploads: [receipt] },
      ],
      uploads: 1,
    });
  } finally {
    clearPrefill();
    cleanup();
  }
});

test('a prefill with uploads the user stops before Zukhruf answers is cleared and not sent after a reload (#6199)', async () => {
  const chatId = 'chat-prefill-uploads-stop';
  const user = userEvent.setup();
  const firstPost = heldFirstPost();
  await using interception = msw.intercept(
    uploadRoute(),
    firstPost.handler,
    http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
      HttpResponse.json(null, { status: 204 }),
    ),
  );
  await writePrefillWithImage(chatId);

  try {
    const first = render(
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <StatusProbe />
        <StopButton />
      </AgentProvider>,
    );
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('submitted');
    });
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('status').textContent).toBe('ready');
    });
    first.unmount();

    render(<ZukhrufPage chatId={chatId} />);
    await act(async () => {});

    expect({
      turns: (await postedTurnMessages(interception.requests)).length,
      pending: readPrefill(),
    }).toEqual({ turns: 1, pending: null });
  } finally {
    firstPost.release();
    clearPrefill();
    cleanup();
  }
});
