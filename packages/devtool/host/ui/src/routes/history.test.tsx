import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RouterProvider, createMemoryRouter } from 'react-router';

import type { HistoryRecord } from '@deepagents/devtool-history';

import { AppLayout } from '../app/layout.tsx';
import { HistoryRoute } from './history.tsx';

const sessionId = '9d1f5c40-f250-4aa9-8979-2e0ef4fc2c15';
const statusHref = '/zukhruf/v1/status/stream';

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(status: unknown) {
    this.dispatchEvent(
      new MessageEvent('status', {
        data: JSON.stringify({ sessionId, status }),
      }),
    );
  }
}

const record: HistoryRecord = {
  chatId: sessionId,
  userId: 'user-1',
  title: 'Research market',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
  status: 'completed' as const,
};

function renderHistory(
  capabilities: Record<string, { href: string }>,
  historyRecord: HistoryRecord = record,
) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppLayout,
        loader: () => ({
          discovery: { capabilities },
          history: [historyRecord],
          historyError: false,
        }),
        children: [
          {
            path: 'history/:userId?/:chatId?',
            Component: HistoryRoute,
            loader: () => ({ conversation: historyRecord }),
          },
        ],
      },
    ],
    { initialEntries: [`/history/${record.userId}/${sessionId}`] },
  );
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  vi.unstubAllGlobals();
});

it('follows the live conversation status in the run list and the conversation badge', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);

  renderHistory({
    chat: { href: '/zukhruf/v1/session' },
    history: { href: '/zukhruf/v1/history' },
    status: { href: statusHref },
  });

  expect(await screen.findByText('completed')).toBeTruthy();
  expect(screen.getByLabelText('completed')).toBeTruthy();
  expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
    statusHref,
  ]);
  const source = FakeEventSource.instances[0];

  act(() => source.emit({ type: 'active', activeFlags: [] }));
  expect(screen.getByText('active')).toBeTruthy();
  expect(screen.getByLabelText('Active').classList.contains('animate-spin')).toBe(
    false,
  );

  act(() =>
    source.emit({ type: 'active', activeFlags: ['waitingOnApproval'] }),
  );
  expect(screen.getByText('approval')).toBeTruthy();
  expect(screen.getByLabelText('Waiting on approval')).toBeTruthy();

  act(() =>
    source.emit({ type: 'active', activeFlags: ['waitingOnUserInput'] }),
  );
  expect(screen.getByText('input')).toBeTruthy();
  expect(screen.getByLabelText('Waiting on user input')).toBeTruthy();

  act(() => source.emit({ type: 'systemError' }));
  expect(screen.getByText('error')).toBeTruthy();
  expect(screen.getByLabelText('Error')).toBeTruthy();

  act(() => source.emit({ type: 'idle' }));
  expect(screen.getByText('idle')).toBeTruthy();
  expect(screen.getByLabelText('idle')).toBeTruthy();

  cleanup();
  expect(source.closed).toBe(true);
});

it('keeps a static loader snapshot when the runtime does not advertise a status stream', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);

  renderHistory(
    {
      chat: { href: '/zukhruf/v1/session' },
      history: { href: '/zukhruf/v1/history' },
    },
    { ...record, status: 'running' },
  );

  expect(await screen.findByText('running')).toBeTruthy();
  expect(
    screen.getByLabelText('Running').classList.contains('animate-spin'),
  ).toBe(false);
  expect(FakeEventSource.instances).toEqual([]);
});
