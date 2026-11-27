import { cleanup, render, screen } from '@testing-library/react';
import { Msw } from '@zukhruf/testing/msw';
import { HttpResponse, http } from 'msw';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { queryClient } from '../app/runtime-data.ts';
import { FakeClock } from '../testing/fake-clock.tsx';
import { Component, loader, shouldRevalidate } from './chat.tsx';

const msw = new Msw();
const sessionId = '6129aaaa-0000-4000-8000-000000000001';
const infoHref = '/zukhruf/v1/info';
const historyHref = '/zukhruf/v1/history';
const api = '/zukhruf/v1/session';
const absolute = (path: string) => new URL(path, location.href).href;

function hostWith(messages: unknown[]) {
  return [
    http.get(absolute(infoHref), () =>
      HttpResponse.json({
        capabilities: {
          chat: { href: api },
          history: { href: historyHref },
          events: { href: '/zukhruf/v1/events' },
        },
      }),
    ),
    http.get(absolute(historyHref), () =>
      HttpResponse.json([
        {
          chatId: sessionId,
          userId: 'user-1',
          createdAt: 1,
          updatedAt: 2,
          messageCount: messages.length,
          status: { type: 'idle' },
        },
      ]),
    ),
    http.get(absolute(`${api}/${sessionId}`), () =>
      HttpResponse.json({
        sessionId,
        messages,
        turns: [],
        status: { type: 'idle' },
      }),
    ),
    http.get(
      absolute(`${api}/${sessionId}/stream`),
      () => new HttpResponse(null, { status: 204 }),
    ),
  ];
}

function openSession() {
  const configuration = document.createElement('meta');
  configuration.name = 'deepagents-zukhruf-info';
  configuration.content = infoHref;
  document.head.append(configuration);
  const router = createMemoryRouter(
    [{ path: '/chat/:sessionId', Component, loader, shouldRevalidate }],
    { initialEntries: [`/chat/${sessionId}`] },
  );
  render(<RouterProvider router={router} />, { wrapper: FakeClock });
  return {
    [Symbol.dispose]() {
      cleanup();
      configuration.remove();
      queryClient.clear();
    },
  };
}

describe('opening an existing session', () => {
  it('shows an empty chat ready for input when the session has no visible message', async () => {
    await using _ = msw.intercept(...hostWith([]));
    using __ = openSession();

    expect(await screen.findByLabelText('Rich prompt composer')).toBeTruthy();
    expect(screen.queryByText('Unable to load this conversation.')).toBeNull();
  });

  it('shows the user message of a session that has one', async () => {
    await using _ = msw.intercept(
      ...hostWith([
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'Hello from the session' }],
        },
      ]),
    );
    using __ = openSession();

    expect(await screen.findByText('Hello from the session')).toBeTruthy();
    expect(screen.getByLabelText('Rich prompt composer')).toBeTruthy();
  });
});
