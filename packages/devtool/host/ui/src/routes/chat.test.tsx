import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  MemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeEventsProvider } from '@deepagents/devtool-history';
import { SidebarProvider } from '@deepagents/react-shadcn';

import { DevtoolSidebar, NewChatButton } from '../app/sidebar.tsx';
import { Component, loader } from './chat.tsx';

const { loadRuntime } = vi.hoisted(() => ({ loadRuntime: vi.fn() }));

vi.mock('../app/runtime-data.ts', () => ({ loadRuntime }));

const sessionId = '9d1f5c40-f250-4aa9-8979-2e0ef4fc2c15';
const api = '/zukhruf/v1/session';
const eventsHref = '/zukhruf/v1/events';
const capabilities = {
  chat: { href: api },
  history: { href: '/zukhruf/v1/history' },
  events: { href: eventsHref },
};

class FakeEventSource extends EventTarget {
  constructor(readonly url: string) {
    super();
  }

  close() {}
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('puts a client-generated durable chat ID in the new-chat URL', () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(sessionId);

  render(
    <MemoryRouter initialEntries={['/history']}>
      <NewChatButton iconOnly />
      <Location />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

  expect(screen.getByTestId('location').textContent).toBe(
    `/chat?chatId=${sessionId}`,
  );
});

it('loads the same query chat ID before creation and after reload', async () => {
  const messages = [
    {
      id: 'message-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Hello' }],
    },
  ];
  const history = {
    chatId: sessionId,
    userId: 'user-1',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    status: { type: 'idle' as const },
  };
  loadRuntime
    .mockResolvedValueOnce({
      discovery: { capabilities },
      history: [],
      historyError: false,
    })
    .mockResolvedValueOnce({
      discovery: { capabilities },
      history: [history],
      historyError: false,
    });
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ sessionId, messages }));
  vi.stubGlobal('fetch', request);

  const first = await load(`/chat?chatId=${sessionId}`);
  expect(request).not.toHaveBeenCalled();
  expect(first).toMatchObject({
    chatId: sessionId,
    conversation: undefined,
    initialMessages: undefined,
    sessionExists: false,
    sessionError: false,
  });

  const reloaded = await load(`/chat?chatId=${sessionId}`);
  expect(reloaded).toMatchObject({
    chatId: sessionId,
    conversation: history,
    initialMessages: messages,
    sessionExists: true,
    sessionError: false,
  });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    `${api}/${sessionId}`,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('highlights a query chat as soon as it appears in Runs', async () => {
  const history = {
    chatId: sessionId,
    userId: 'user-1',
    title: 'New conversation',
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    status: { type: 'idle' as const },
  };
  vi.stubGlobal('EventSource', FakeEventSource);
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <RuntimeEventsProvider href={eventsHref} onEvent={() => {}}>
            <SidebarProvider>
              <DevtoolSidebar />
              <Outlet />
            </SidebarProvider>
          </RuntimeEventsProvider>
        ),
        loader: () => ({
          discovery: { capabilities },
          history: [history],
          historyError: false,
        }),
        children: [
          {
            path: 'chat',
            element: null,
            loader: () => ({ chatId: sessionId, conversation: undefined }),
          },
        ],
      },
    ],
    { initialEntries: [`/chat?chatId=${sessionId}`] },
  );

  render(<RouterProvider router={router} />);

  expect(
    (
      await screen.findByRole('button', { name: /New conversation/ })
    ).getAttribute('aria-current'),
  ).toBe('true');
});

it('only offers image attachments when the runtime advertises uploads', async () => {
  const runtimeCapabilities = {
    chat: { href: api },
    history: { href: '/zukhruf/v1/history' },
  };
  const renderChat = (uploads: { href: string } | undefined) => {
    const router = createMemoryRouter(
      [
        {
          path: '/chat/:sessionId',
          Component,
          loader: () => ({
            chatId: sessionId,
            discovery: {
              capabilities: {
                ...runtimeCapabilities,
                ...(uploads && { uploads }),
              },
            },
            initialMessages: undefined,
            sessionError: false,
            sessionExists: false,
          }),
        },
      ],
      { initialEntries: [`/chat/${sessionId}`] },
    );
    return render(<RouterProvider router={router} />);
  };

  const withoutUploads = renderChat(undefined);
  await screen.findByLabelText('Rich prompt composer');
  expect(screen.queryByRole('button', { name: 'Attach image' })).toBeNull();
  withoutUploads.unmount();

  renderChat({ href: api });
  expect(
    await screen.findByRole('button', { name: 'Attach image' }),
  ).toBeTruthy();
});

function load(path: string) {
  const url = new URL(`http://localhost${path}`);
  return loader({
    context: new RouterContextProvider(),
    params: {},
    pattern: '/chat/:sessionId?',
    request: new Request(url),
    url,
  });
}

function Location() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
