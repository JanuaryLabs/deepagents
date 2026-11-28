import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Toaster } from '@zukhruf/shadcn';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import { HttpResponse, http } from 'msw';
import { type ReactNode, useState } from 'react';
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

/**
 * A turn the server keeps running: its stream sends 'Thinking' and stays open.
 * A reconnect replays the turn from its start, as Zukhruf's stream route does,
 * and goes on to its end once `ends` resolves.
 */
function resumableTurn(ends: Promise<void>) {
  let streams = 0;
  return http.get(`${zukhrufApi}/:sessionId/stream`, ({ request }) => {
    streams += 1;
    const replay = streams > 1;
    const encoder = new TextEncoder();
    const send = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      chunks: readonly object[],
    ) => controller.enqueue(encoder.encode(frames(chunks)));
    return new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          send(controller, [
            { type: 'start', messageId: 'answer-1' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Thinking' },
            ...(replay
              ? [{ type: 'text-delta', id: 't1', delta: ' it through.' }]
              : []),
          ]);
          request.signal.addEventListener('abort', () => controller.close(), {
            once: true,
          });
          if (!replay) return;
          void ends.then(() => {
            if (request.signal.aborted) return;
            send(controller, [
              { type: 'text-delta', id: 't1', delta: ' Done.' },
              { type: 'text-end', id: 't1' },
              { type: 'finish' },
            ]);
            controller.close();
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

function ComposerChat() {
  const { submit } = useAgent();
  const { status } = useAgentStatus();
  const { messages } = useAgentMessages();
  return (
    <>
      <ol aria-label="messages">
        {messages.map((message) => (
          <li key={message.id}>
            {message.parts
              .map((part) => (part.type === 'text' ? part.text : ''))
              .join('')}
          </li>
        ))}
      </ol>
      <ChatComposer.Provider
        onSubmit={({ prompt, persistedPrompt }) =>
          submit({ prompt, persistedPrompt })
        }
      >
        <ChatComposer.Root>
          <ChatComposer.Content>
            <ChatComposer.Editor />
          </ChatComposer.Content>
          <ChatComposer.Toolbar>
            {status === 'submitted' || status === 'streaming' ? (
              <ChatComposer.Stop />
            ) : null}
          </ChatComposer.Toolbar>
        </ChatComposer.Root>
      </ChatComposer.Provider>
    </>
  );
}

function renderChat(chat: ReactNode) {
  render(
    <ClockProvider clock={createClock()}>
      <Toaster>
        <AgentProvider
          chatId="11111111-1111-4111-8111-111111111111"
          transport={new ZukhrufChatTransport({ api: zukhrufApi })}
          onResetChat={() => {}}
        >
          {chat}
        </AgentProvider>
      </Toaster>
    </ClockProvider>,
  );
}

/** Asks 'first', presses Stop, and waits for the refused cancel's resumed answer. */
async function stopRefusedOnce() {
  const user = userEvent.setup();
  renderChat(<ComposerChat />);
  await user.click(
    screen.getByRole('textbox', { name: 'Rich prompt composer' }),
  );
  await user.keyboard('first{Enter}');
  await user.click(
    await screen.findByRole('button', { name: 'Stop streaming' }),
  );
  await vi.waitFor(() =>
    expect(screen.getByText('Thinking it through.')).toBeInTheDocument(),
  );
  return user;
}

const stopFailed = 'Could not stop the answer. It may still be running.';
/** The host's one @zukhruf/shadcn Toaster: Base UI's viewport, a region named 'Notifications'. */
const toasts = () =>
  within(screen.getByRole('region', { name: 'Notifications' }));

/** Counts each time a 'Could not stop' toast is put on the page, until disposed. */
function stopFailedToastsShown() {
  let shown = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.textContent?.includes(stopFailed)) {
          shown += 1;
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    get shown() {
      return shown;
    },
    [Symbol.dispose]: () => observer.disconnect(),
  };
}

function cancelPosts(requests: readonly Request[]) {
  return requests.filter((request) => request.url.endsWith('/cancel')).length;
}

function streamReads(requests: readonly Request[]) {
  return requests.filter((request) => request.url.endsWith('/stream')).length;
}

describe('A second Stop after the server refused the first (#6340)', () => {
  it('sends its cancel while the resumed turn still streams, and freezes the answer when the server accepts it', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const turnEnds = Promise.withResolvers<void>();
    stack.defer(turnEnds.resolve);
    let cancels = 0;
    await using interception = msw.intercept(
      acceptTurns(),
      resumableTurn(turnEnds.promise),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () => {
        cancels += 1;
        return cancels === 1
          ? HttpResponse.json({ error: 'Conflict' }, { status: 409 })
          : new HttpResponse(null, { status: 204 });
      }),
    );
    const user = await stopRefusedOnce();
    expect(await toasts().findByText(stopFailed)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop streaming' }));

    await vi.waitFor(() => expect(cancelPosts(interception.requests)).toBe(2));
    await vi.waitFor(() => expect(toasts().queryByText(stopFailed)).toBeNull());
    turnEnds.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect({
      messages: within(screen.getByRole('list', { name: 'messages' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
      stop: screen.queryByRole('button', { name: 'Stop streaming' }),
      streamReads: streamReads(interception.requests),
    }).toEqual({
      messages: ['first', 'Thinking it through.'],
      stop: null,
      streamReads: 2,
    });
  });

  it('resumes the answer again and keeps one toast when the server refuses it too, and shows no toast once the answer finished', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const turnEnds = Promise.withResolvers<void>();
    stack.defer(turnEnds.resolve);
    await using interception = msw.intercept(
      acceptTurns(),
      resumableTurn(turnEnds.promise),
      http.post(`${zukhrufApi}/:sessionId/cancel`, () =>
        HttpResponse.json({ error: 'Conflict' }, { status: 409 }),
      ),
    );
    using toastsShown = stopFailedToastsShown();
    const user = await stopRefusedOnce();
    expect(await toasts().findByText(stopFailed)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Stop streaming' }));

    await vi.waitFor(() => expect(streamReads(interception.requests)).toBe(3));
    await vi.waitFor(() =>
      expect(screen.getByText('Thinking it through.')).toBeInTheDocument(),
    );
    const cancelsWhileStreaming = cancelPosts(interception.requests);
    const toastWhileStreaming = toasts().queryByText(stopFailed) !== null;
    turnEnds.resolve();
    await vi.waitFor(() =>
      expect(
        screen.getByText('Thinking it through. Done.'),
      ).toBeInTheDocument(),
    );
    await vi.waitFor(() => expect(toasts().queryByText(stopFailed)).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect({
      cancelsWhileStreaming,
      toastWhileStreaming,
      cancels: cancelPosts(interception.requests),
      toastsShown: toastsShown.shown,
      toastAfterAnswer: toasts().queryByText(stopFailed),
    }).toEqual({
      cancelsWhileStreaming: 2,
      toastWhileStreaming: true,
      cancels: 2,
      toastsShown: 1,
      toastAfterAnswer: null,
    });
  });
});

function StopTwiceChat() {
  const { submit, stop } = useAgent();
  const { status } = useAgentStatus();
  const [outcomes, setOutcomes] = useState<string[]>([]);
  const record = (press: string, outcome: Promise<void>) =>
    outcome.then(
      () => setOutcomes((all) => [...all, `${press} cancelled`]),
      (error: Error) =>
        setOutcomes((all) => [...all, `${press} failed: ${error.name}`]),
    );
  return (
    <>
      <output aria-label="status">{status}</output>
      <output aria-label="outcomes">{outcomes.join(', ')}</output>
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
        onClick={() => {
          void record('first Stop', stop());
          void record('second Stop', stop());
        }}
      >
        Stop twice
      </button>
    </>
  );
}

describe('useAgent().stop() pressed again before the first cancel answers (#6340)', () => {
  it('sends both cancels at once, and a late refusal of the first does not resume the turn the second cancelled', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const turnEnds = Promise.withResolvers<void>();
    stack.defer(turnEnds.resolve);
    const firstCancelAnswers = Promise.withResolvers<void>();
    stack.defer(firstCancelAnswers.resolve);
    let cancels = 0;
    await using interception = msw.intercept(
      acceptTurns(),
      resumableTurn(turnEnds.promise),
      http.post(`${zukhrufApi}/:sessionId/cancel`, async () => {
        cancels += 1;
        if (cancels > 1) return new HttpResponse(null, { status: 204 });
        await firstCancelAnswers.promise;
        return HttpResponse.json({ error: 'Conflict' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    renderChat(<StopTwiceChat />);
    await user.click(screen.getByRole('button', { name: 'Ask first' }));
    await vi.waitFor(() =>
      expect(screen.getByLabelText('status').textContent).toBe('streaming'),
    );

    await user.click(screen.getByRole('button', { name: 'Stop twice' }));

    await vi.waitFor(() => expect(cancelPosts(interception.requests)).toBe(2));
    firstCancelAnswers.resolve();
    await vi.waitFor(() =>
      expect(screen.getByLabelText('outcomes').textContent).toContain(
        'second Stop',
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect({
      outcomes: screen.getByLabelText('outcomes').textContent,
      status: screen.getByLabelText('status').textContent,
      streamReads: streamReads(interception.requests),
    }).toEqual({
      outcomes: 'first Stop failed: AI_APICallError, second Stop cancelled',
      status: 'ready',
      streamReads: 1,
    });
  });
});
