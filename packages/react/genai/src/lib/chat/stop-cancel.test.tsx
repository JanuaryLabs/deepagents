import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import { HttpResponse, http } from 'msw';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  ZukhrufChatTransport,
  useAgent,
  useAgentMessages,
  useAgentStatus,
} from '@deepagents/react-genai';

const msw = new Msw();
const zukhrufApi = new URL('/zukhruf/v1/session', location.href).href;
const sse = {
  'content-type': 'text/event-stream',
  'x-vercel-ai-ui-message-stream': 'v1',
};

function frames(chunks: readonly object[]) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
}

/** The first turn streams one delta and stays open; every later turn answers 'Second answer.' */
function turnStreams() {
  let turns = 0;
  return http.get(`${zukhrufApi}/:sessionId/stream`, ({ request }) => {
    turns += 1;
    if (turns > 1) {
      return new HttpResponse(
        frames([
          { type: 'start' },
          { type: 'text-start', id: 't2' },
          { type: 'text-delta', id: 't2', delta: 'Second answer.' },
          { type: 'text-end', id: 't2' },
          { type: 'finish' },
        ]) + 'data: [DONE]\n\n',
        { headers: sse },
      );
    }
    const encoder = new TextEncoder();
    return new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              frames([
                { type: 'start' },
                { type: 'text-start', id: 't1' },
                { type: 'text-delta', id: 't1', delta: 'Thinking' },
              ]),
            ),
          );
          request.signal.addEventListener('abort', () => controller.close(), {
            once: true,
          });
        },
      }),
      { headers: sse },
    );
  });
}

function acceptTurns() {
  let turn = 0;
  return http.post(`${zukhrufApi}/:sessionId`, ({ params }) => {
    turn += 1;
    return HttpResponse.json(
      { ok: true, sessionId: params.sessionId, turnId: `turn-${turn}` },
      { status: 202 },
    );
  });
}

function Chat() {
  const { submit, stop } = useAgent();
  const { status, messages } = useAgentMessages();
  const [stopError, setStopError] = useState<unknown>();
  return (
    <>
      <output aria-label="status">{status}</output>
      {stopError ? <p role="alert">{String(stopError)}</p> : null}
      <ol aria-label="messages">
        {messages.map((message) => (
          <li key={message.id}>
            {message.parts
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('')}
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() =>
          void submit({ prompt: 'first', persistedPrompt: 'first' })
        }
      >
        Ask first
      </button>
      <button
        type="button"
        onClick={() =>
          void submit({ prompt: 'second', persistedPrompt: 'second' })
        }
      >
        Ask second
      </button>
      <button
        type="button"
        onClick={() => void Promise.resolve(stop()).catch(setStopError)}
      >
        Stop
      </button>
    </>
  );
}

function renderChat() {
  render(
    <AgentProvider
      chatId="11111111-1111-4111-8111-111111111111"
      transport={new ZukhrufChatTransport({ api: zukhrufApi })}
      onResetChat={() => {}}
    >
      <Chat />
    </AgentProvider>,
  );
}

const status = () => screen.getByLabelText('status').textContent;

/** Starts a turn whose stream stays open and presses Stop while it streams. */
async function stopStreamingTurn() {
  const user = userEvent.setup();
  renderChat();
  await user.click(screen.getByRole('button', { name: 'Ask first' }));
  await vi.waitFor(() => expect(status()).toBe('streaming'));
  await user.click(screen.getByRole('button', { name: 'Stop' }));
  return user;
}

/** Records every unhandled rejection the process sees until disposed. */
function unhandledRejections() {
  const reasons: unknown[] = [];
  const listener = (reason: unknown) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  return {
    reasons,
    [Symbol.dispose]: () => process.off('unhandledRejection', listener),
  };
}

describe('Stop on a streaming Zukhruf turn whose cancel fails (#6222)', () => {
  it('leaves no unhandled rejection when the cancel fails at the network', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using rejections = unhandledRejections();
    await using interception = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => HttpResponse.error()),
    );

    await stopStreamingTurn();
    await vi.waitFor(() =>
      expect(
        interception.requests.some((request) =>
          request.url.endsWith('/cancel'),
        ),
      ).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rejections.reasons.map(String)).toEqual([]);
  });

  it('tells the user the turn may still run when the cancel answers 500', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using rejections = unhandledRejections();
    await using _ = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
        HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      ),
    );

    await stopStreamingTurn();

    expect({
      rejections: rejections.reasons.length,
      status: status(),
    }).toEqual({ rejections: 0, status: 'ready' });
    expect(await screen.findByRole('alert', {}, { timeout: 500 })).toBeTruthy();
  });

  it('tells the user the turn may still run when the cancel fails at the network', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using _rejections = unhandledRejections();
    await using _ = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => HttpResponse.error()),
    );

    await stopStreamingTurn();

    expect(await screen.findByRole('alert', {}, { timeout: 500 })).toBeTruthy();
  });

  it('sends a question asked after Stop only once the cancel has answered', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const answer = Promise.withResolvers<void>();
    await using interception = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, async () => {
        await answer.promise;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const turnPosts = () =>
      interception.requests.filter(
        (request) =>
          request.method === 'POST' && !request.url.endsWith('/cancel'),
      ).length;

    try {
      const user = await stopStreamingTurn();
      await user.click(screen.getByRole('button', { name: 'Ask second' }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect({ status: status(), turnPosts: turnPosts() }).toEqual({
        status: 'ready',
        turnPosts: 1,
      });
    } finally {
      answer.resolve();
    }
    await vi.waitFor(() =>
      expect(screen.getByText('Second answer.')).toBeInTheDocument(),
    );
    expect(turnPosts()).toBe(2);
  });

  it('answers a later question after a failed cancel', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using _rejections = unhandledRejections();
    await using _ = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => HttpResponse.error()),
    );

    const user = await stopStreamingTurn();
    await vi.waitFor(() => expect(status()).toBe('ready'));
    await user.click(screen.getByRole('button', { name: 'Ask second' }));

    await vi.waitFor(() =>
      expect(screen.getByText('Second answer.')).toBeInTheDocument(),
    );
  });
});

/** A host's composer: Stop while the answer runs, and the composer's alert. */
function ComposerChat() {
  const { submit } = useAgent();
  const { status } = useAgentStatus();
  return (
    <ChatComposer.Provider
      onSubmit={({ prompt, persistedPrompt }) =>
        submit({ prompt, persistedPrompt })
      }
    >
      <ChatComposer.Root>
        <ChatComposer.Content>
          <ChatComposer.Editor />
          <ChatComposer.Error />
        </ChatComposer.Content>
        <ChatComposer.Toolbar>
          {status === 'submitted' || status === 'streaming' ? (
            <ChatComposer.Stop />
          ) : null}
        </ChatComposer.Toolbar>
      </ChatComposer.Root>
    </ChatComposer.Provider>
  );
}

async function stopInComposer() {
  const user = userEvent.setup();
  render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="11111111-1111-4111-8111-111111111111"
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <ComposerChat />
      </AgentProvider>
    </ClockProvider>,
  );
  await user.click(
    screen.getByRole('textbox', { name: 'Rich prompt composer' }),
  );
  await user.keyboard('first{Enter}');
  await user.click(
    await screen.findByRole('button', { name: 'Stop streaming' }),
  );
  return user;
}

describe('ChatComposer.Stop (#6222)', () => {
  it("says in the composer's alert that the answer may still run when the cancel fails", async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using rejections = unhandledRejections();
    await using _ = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
        HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      ),
    );

    await stopInComposer();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not stop the answer. It may still be running.',
    );
    expect(rejections.reasons).toEqual([]);
  });

  it('clears that alert when the user sends the next question', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    using _rejections = unhandledRejections();
    await using interception = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => HttpResponse.error()),
    );
    const user = await stopInComposer();
    await screen.findByRole('alert');

    await user.click(
      screen.getByRole('textbox', { name: 'Rich prompt composer' }),
    );
    await user.keyboard('second{Enter}');

    await vi.waitFor(() =>
      expect(
        interception.requests.filter(
          (request) =>
            request.method === 'POST' && !request.url.endsWith('/cancel'),
        ),
      ).toHaveLength(2),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no alert once the cancel answers', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const answered = Promise.withResolvers<void>();
    await using _ = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => {
        queueMicrotask(answered.resolve);
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await stopInComposer();
    await answered.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Leaving a streaming chat (#6222)', () => {
  it('lets its turn run on: unmounting sends no cancel', async () => {
    const user = userEvent.setup();
    await using interception = msw.intercept(
      acceptTurns(),
      turnStreams(),
      http.post(
        `${zukhrufApi}/:sessionId/cancel`,
        () => new HttpResponse(null, { status: 204 }),
      ),
    );
    const view = render(
      <AgentProvider
        chatId="11111111-1111-4111-8111-111111111111"
        transport={new ZukhrufChatTransport({ api: zukhrufApi })}
        onResetChat={() => {}}
      >
        <Chat />
      </AgentProvider>,
    );
    try {
      await user.click(screen.getByRole('button', { name: 'Ask first' }));
      await vi.waitFor(() => expect(status()).toBe('streaming'));
    } finally {
      view.unmount();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      interception.requests.filter((request) =>
        request.url.endsWith('/cancel'),
      ),
    ).toEqual([]);
  });
});
