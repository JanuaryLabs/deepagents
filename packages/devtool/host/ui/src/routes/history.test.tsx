import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { HistoryRecord } from '@deepagents/devtool-history';

import { AppLayout } from '../app/layout.tsx';
import { queryClient } from '../app/runtime-data.ts';
import { HistoryRoute } from './history.tsx';

const sessionId = '9d1f5c40-f250-4aa9-8979-2e0ef4fc2c15';
const eventsHref = '/zukhruf/v1/events';

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

  emit(event: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) }),
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
  status: { type: 'idle' as const },
};

function renderHistory(
  capabilities: Record<string, { href: string }>,
  historyRecord: HistoryRecord = record,
) {
  let layoutLoads = 0;
  const router = createMemoryRouter(
    [
      {
        path: '/',
        Component: AppLayout,
        loader: () => {
          layoutLoads++;
          return {
            discovery: { capabilities },
            history: [historyRecord],
            historyError: false,
          };
        },
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
  return {
    ...render(<RouterProvider router={router} />),
    layoutLoads: () => layoutLoads,
  };
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  queryClient.clear();
  vi.unstubAllGlobals();
});

it('follows the live conversation status in the run list and the conversation badge', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);

  const view = renderHistory({
    chat: { href: '/zukhruf/v1/session' },
    history: { href: '/zukhruf/v1/history' },
    events: { href: eventsHref },
  });

  expect(await screen.findByText('idle')).toBeTruthy();
  expect(screen.getByLabelText('idle')).toBeTruthy();
  expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
    eventsHref,
  ]);
  const source = FakeEventSource.instances[0];

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'active', activeFlags: [] },
    }),
  );
  expect(screen.getByText('active')).toBeTruthy();
  expect(
    screen.getByLabelText('Active').classList.contains('animate-spin'),
  ).toBe(false);

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    }),
  );
  expect(screen.getByText('approval')).toBeTruthy();
  expect(screen.getByLabelText('Waiting on approval')).toBeTruthy();

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    }),
  );
  expect(screen.getByText('input')).toBeTruthy();
  expect(screen.getByLabelText('Waiting on user input')).toBeTruthy();

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'systemError' },
    }),
  );
  expect(screen.getByText('error')).toBeTruthy();
  expect(screen.getByLabelText('Error')).toBeTruthy();
  await waitFor(() => expect(view.layoutLoads()).toBeGreaterThan(1));

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'idle' },
    }),
  );
  expect(screen.getByText('idle')).toBeTruthy();
  expect(screen.getByLabelText('idle')).toBeTruthy();

  const loadsBeforeReady = view.layoutLoads();
  act(() => source.emit({ type: 'ready' }));
  await waitFor(() =>
    expect(view.layoutLoads()).toBeGreaterThan(loadsBeforeReady),
  );

  act(() =>
    source.emit({
      type: 'change',
      resource: 'conversation',
      id: sessionId,
      status: { type: 'not-real' },
    }),
  );
  expect(screen.getByText('idle')).toBeTruthy();

  cleanup();
  expect(source.closed).toBe(true);
});

it('invalidates only the schedule queries named by owner events', async () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  const tasksKey = ['schedules', 'tasks', '/zukhruf/v1/schedules'];
  const inboxKey = ['schedules', 'inbox', '/zukhruf/v1/schedules'];
  queryClient.setQueryData(tasksKey, []);
  queryClient.setQueryData(inboxKey, []);
  renderHistory({
    chat: { href: '/zukhruf/v1/session' },
    history: { href: '/zukhruf/v1/history' },
    events: { href: eventsHref },
    schedules: { href: '/zukhruf/v1/schedules' },
  });
  await screen.findByText('idle');
  const source = FakeEventSource.instances[0];

  act(() =>
    source.emit({
      type: 'change',
      resource: 'schedule-task',
      id: 'task-1',
    }),
  );
  await waitFor(() =>
    expect(queryClient.getQueryState(tasksKey)?.isInvalidated).toBe(true),
  );
  expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(false);

  queryClient.setQueryData(tasksKey, []);
  act(() =>
    source.emit({
      type: 'change',
      resource: 'schedule-run',
      id: 'run-1',
      taskId: 'task-1',
    }),
  );
  await waitFor(() =>
    expect(queryClient.getQueryState(inboxKey)?.isInvalidated).toBe(true),
  );
  expect(queryClient.getQueryState(tasksKey)?.isInvalidated).toBe(false);
});
