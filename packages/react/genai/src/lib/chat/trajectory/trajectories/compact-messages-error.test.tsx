import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import { APICallError } from 'ai';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  AgentProvider,
  CompactMessages,
  GenaiMessagesProvider,
  ZukhrufChatTransport,
  useAgent,
  useAgentMessages,
} from '@deepagents/react-genai';

const msw = new Msw();
const sessions = new URL('/sessions', location.href).href;
const sessionNotFound = {
  cause: {
    code: 'zukhruf/session-not-found',
    detail: 'No session chat-1 on this host',
  },
  error: 'Session not found',
};

function Chat({ children }: { children?: (error: Error) => ReactNode }) {
  const { submit } = useAgent();
  const { messages, status, error, regenerate } = useAgentMessages();
  return (
    <>
      <button
        type="button"
        onClick={() => void submit({ prompt: 'Hi', persistedPrompt: 'Hi' })}
      >
        Ask
      </button>
      <CompactMessages.Root messages={messages} status={status}>
        <CompactMessages.Error error={error} onRetry={() => void regenerate()}>
          {children}
        </CompactMessages.Error>
      </CompactMessages.Root>
    </>
  );
}

function renderChat(chat: ReactNode) {
  return render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="chat-1"
        transport={new ZukhrufChatTransport({ api: sessions })}
        onResetChat={() => {}}
      >
        {chat}
      </AgentProvider>
    </ClockProvider>,
  );
}

function visibleText() {
  return document.body.textContent ?? '';
}

describe('CompactMessages.Error', () => {
  it('shows a readable sentence and the retry button, not the JSON body, when the host answers 404', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using _ = msw.intercept(
      http.post(`${sessions}/chat-1`, () =>
        HttpResponse.json(sessionNotFound, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderChat(<Chat />);

    await user.click(screen.getByRole('button', { name: 'Ask' }));

    expect(
      await screen.findByRole('button', { name: 'Try Again' }),
    ).toBeInTheDocument();
    expect(visibleText()).not.toMatch(/\{|zukhruf\/|Session not found/);
    expect(screen.getByRole('alert').textContent).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('shows the Arabic sentence and retry from GenaiMessagesProvider when the host answers 404', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using _ = msw.intercept(
      http.post(`${sessions}/chat-1`, () =>
        HttpResponse.json(sessionNotFound, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderChat(
      <GenaiMessagesProvider
        locale="ar"
        messages={{
          'chat.error': 'حدث خطأ. حاول مجددًا.',
          'chat.retry': 'حاول مجددًا',
        }}
      >
        <Chat />
      </GenaiMessagesProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Ask' }));

    expect(
      await screen.findByRole('button', { name: 'حاول مجددًا' }),
    ).toBeInTheDocument();
    expect(visibleText()).not.toMatch(/\{|zukhruf\/|Session not found/);
    expect(screen.getByRole('alert').textContent).toBe('حدث خطأ. حاول مجددًا.');
  });

  it('says the request was rate limited when the host answers 429', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using _ = msw.intercept(
      http.post(`${sessions}/chat-1`, () =>
        HttpResponse.json({ error: 'Too many requests' }, { status: 429 }),
      ),
    );
    const user = userEvent.setup();
    renderChat(<Chat />);

    await user.click(screen.getByRole('button', { name: 'Ask' }));

    await screen.findByRole('button', { name: 'Try Again' });
    expect(screen.getByRole('alert').textContent).toBe(
      'Too many requests. Wait a moment, then try again.',
    );
  });

  it('draws what the host renders from the error in place of the sentence, and keeps the retry button', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using _ = msw.intercept(
      http.post(`${sessions}/chat-1`, () =>
        HttpResponse.json(sessionNotFound, { status: 404 }),
      ),
    );
    const user = userEvent.setup();
    renderChat(
      <Chat>
        {(error) =>
          APICallError.isInstance(error) && error.statusCode === 404
            ? 'This conversation has ended.'
            : 'Other failure'
        }
      </Chat>,
    );

    await user.click(screen.getByRole('button', { name: 'Ask' }));

    expect(
      await screen.findByRole('button', { name: 'Try Again' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toBe(
      'This conversation has ended.',
    );
  });
});
