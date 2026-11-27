import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SidebarProvider } from '@zukhruf/shadcn';
import {
  MemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from 'react-router';
import { expect, it, vi } from 'vitest';

import { RuntimeEventsProvider } from '@deepagents/devtool-history';

import { queryClient } from '../app/runtime-data.ts';
import { DevtoolSidebar, NewChatButton } from '../app/sidebar.tsx';
import { FakeClock } from '../testing/fake-clock.tsx';
import { Component, loader } from './chat.tsx';

const sessionId = '9d1f5c40-f250-4aa9-8979-2e0ef4fc2c15';
const api = '/zukhruf/v1/session';
const eventsHref = '/zukhruf/v1/events';
const infoHref = '/zukhruf/v1/info';
const historyHref = '/zukhruf/v1/history';
const capabilities = {
  chat: { href: api },
  history: { href: historyHref },
  events: { href: eventsHref },
};

class FakeEventSource extends EventTarget {
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  close() {}
}

it('puts a client-generated durable chat ID in the new-chat URL', () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(sessionId);
  try {
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
  } finally {
    cleanup();
    vi.restoreAllMocks();
  }
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
  const configuration = document.createElement('meta');
  configuration.name = 'deepagents-zukhruf-info';
  configuration.content = infoHref;
  document.head.append(configuration);
  const runs = vi
    .fn<() => (typeof history)[]>()
    .mockReturnValueOnce([])
    .mockReturnValueOnce([history]);
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ sessionId, messages }));
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === infoHref) {
      return Promise.resolve(Response.json({ capabilities }));
    }
    if (input === historyHref) return Promise.resolve(Response.json(runs()));
    return request(input, init);
  });
  try {
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
  } finally {
    configuration.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
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
  try {
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
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

it('only offers file attachments when the runtime advertises uploads, accepting what it lists up to its size limit', async () => {
  const runtimeCapabilities = {
    chat: { href: api },
    history: { href: '/zukhruf/v1/history' },
  };
  const renderChat = (
    uploads:
      { href: string; mediaTypes?: string[]; maxBytes: number } | undefined,
  ) => {
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
    return render(<RouterProvider router={router} />, { wrapper: FakeClock });
  };

  try {
    const withoutUploads = renderChat(undefined);
    await screen.findByLabelText('Rich prompt composer');
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    withoutUploads.unmount();

    const withUploads = renderChat({ href: api, maxBytes: 5_000_000 });
    expect(
      await screen.findByRole('button', { name: 'Attach files' }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Attach media files').getAttribute('accept'),
    ).toBe('image/*,video/*,audio/*');
    withUploads.unmount();

    renderChat({
      href: api,
      mediaTypes: ['image/png', 'video/mp4'],
      maxBytes: 5_000_000,
    });
    const input = await screen.findByLabelText('Attach media files');
    expect(input.getAttribute('accept')).toBe('image/png,video/mp4');
    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array(5_000_001)], 'scan.png', {
            type: 'image/png',
          }),
        ],
      },
    });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Files over 5 MB cannot be attached: scan.png',
    );
  } finally {
    cleanup();
  }
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
