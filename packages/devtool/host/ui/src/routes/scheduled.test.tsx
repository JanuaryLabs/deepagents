import { QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';

import type { HistoryRecord } from '@deepagents/devtool-history';

import { queryClient } from '../app/runtime-data.ts';
import type {
  ScheduledRunView,
  ScheduledTaskView,
} from '../app/schedules-data.ts';
import { ScheduledRoute } from './scheduled.tsx';

const SCHEDULES = '/zukhruf/v1/schedules';

const conversation: HistoryRecord = {
  chatId: '9d1f5c40-f250-4aa9-8979-2e0ef4fc2c15',
  userId: 'user-1',
  title: 'Research market',
  createdAt: 1,
  updatedAt: 2,
  messageCount: 3,
  status: { type: 'idle' },
};

const task: ScheduledTaskView = {
  id: '0f4c2a1e-6b7d-4e8f-9a0b-1c2d3e4f5a6b',
  name: 'Weekly digest',
  prompt: 'Summarize this week.',
  recurrence: '0 9 * * 1',
  timezone: 'UTC',
  target: { kind: 'new-conversation' },
  status: 'active',
  nextRunAt: 1_767_600_000_000,
  createdAt: 1_767_000_000_000,
  updatedAt: 1_767_000_000_000,
  archivedAt: null,
};

/**
 * Stands in for the schedules HTTP API: answers only the requests a test
 * names ("METHOD url") and records any other, so a mistyped route cannot
 * pass as the error state a test looks for.
 */
function schedulesApi(
  routes: Record<string, (init?: RequestInit) => Response>,
) {
  const unexpected: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = `${init?.method ?? 'GET'} ${String(input)}`;
    const answer = routes[request];
    if (!answer) {
      unexpected.push(request);
      throw new Error(`Unexpected request: ${request}`);
    }
    return answer(init);
  });
  return { fetch, unexpected };
}

function renderScheduled(path: string) {
  const loaderData = {
    discovery: {
      capabilities: {
        chat: { href: '/zukhruf/v1/session' },
        history: { href: '/zukhruf/v1/history' },
        events: { href: '/zukhruf/v1/events' },
        schedules: { href: SCHEDULES },
      },
    },
    history: [conversation],
    historyError: false,
    conversation,
  };
  const router = createMemoryRouter(
    [
      {
        path: '/scheduled/tasks/:taskId?',
        Component: ScheduledRoute,
        loader: () => loaderData,
      },
      {
        path: '/scheduled/tasks/:taskId/runs/:runId',
        Component: ScheduledRoute,
        loader: () => loaderData,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Answers each POST with the next response in `answers`, keeping its idempotency key. */
function keyedPosts(answers: Array<() => Response>) {
  const keys: Array<string | null> = [];
  const answer = (init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get('idempotency-key'));
    const next = answers[keys.length - 1];
    if (!next) throw new Error(`No answer for POST #${keys.length}`);
    return next();
  };
  return { answer, keys };
}

/** The request never gets a response, as when the connection drops: fetch rejects. */
function droppedConnection(): Response {
  throw new TypeError('Failed to fetch');
}

/** Hono's answer to an error no route handles: a plain-text 500. */
function serverError() {
  return new Response('Internal Server Error', { status: 500 });
}

const createdTask: ScheduledTaskView = {
  ...task,
  id: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  name: 'Release notes',
  prompt: 'Draft the release notes.',
};

async function openCreateDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('Name'), {
    target: { value: createdTask.name },
  });
  fireEvent.change(within(dialog).getByLabelText('Prompt'), {
    target: { value: createdTask.prompt },
  });
  return dialog;
}

const failedCreates = {
  'loses its connection': droppedConnection,
  'answers a task that does not match the task view': () =>
    Response.json({ id: createdTask.id }),
};

for (const [failure, firstAnswer] of Object.entries(failedCreates)) {
  it(`retries a create with the same idempotency key after the create ${failure}`, async () => {
    const posts = keyedPosts([firstAnswer, () => Response.json(createdTask)]);
    const api = schedulesApi({
      [`GET ${SCHEDULES}/tasks`]: () => Response.json([task]),
      [`GET ${SCHEDULES}/runs/inbox`]: () => Response.json([]),
      [`GET ${SCHEDULES}/tasks/${createdTask.id}/runs`]: () =>
        Response.json([]),
      [`POST ${SCHEDULES}/tasks`]: posts.answer,
    });
    vi.stubGlobal('fetch', api.fetch);
    try {
      renderScheduled('/scheduled/tasks');
      const dialog = await openCreateDialog();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      expect(await screen.findByText('Action failed')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      expect(posts.keys).toHaveLength(2);
      expect(posts.keys[0]).toBeTruthy();
      expect(posts.keys[1]).toBe(posts.keys[0]);
      expect(api.unexpected).toEqual([]);
    } finally {
      cleanup();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
}

it('sends an edited draft with a new idempotency key after a failed create', async () => {
  const posts = keyedPosts([
    droppedConnection,
    () => Response.json(createdTask),
  ]);
  const api = schedulesApi({
    [`GET ${SCHEDULES}/tasks`]: () => Response.json([task]),
    [`GET ${SCHEDULES}/runs/inbox`]: () => Response.json([]),
    [`GET ${SCHEDULES}/tasks/${createdTask.id}/runs`]: () => Response.json([]),
    [`POST ${SCHEDULES}/tasks`]: posts.answer,
  });
  vi.stubGlobal('fetch', api.fetch);
  try {
    renderScheduled('/scheduled/tasks');
    const dialog = await openCreateDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('Action failed')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Release notes, weekly' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[1]).toBeTruthy();
    expect(posts.keys[1]).not.toBe(posts.keys[0]);
    expect(api.unexpected).toEqual([]);
  } finally {
    cleanup();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});

const manualRun: ScheduledRunView = {
  id: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  taskId: task.id,
  trigger: 'manual',
  occurrenceAt: 1_767_100_000_000,
  prompt: task.prompt,
  target: task.target,
  status: 'dispatching',
  reviewStatus: null,
  conversation: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  createdAt: 1_767_100_000_000,
  updatedAt: 1_767_100_000_000,
};

async function runNow() {
  fireEvent.click(await screen.findByRole('button', { name: 'Task actions' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Run now' }));
}

function renderTaskWithRuns(
  posts: ReturnType<typeof keyedPosts>,
  runs: () => ScheduledRunView[],
) {
  const api = schedulesApi({
    [`GET ${SCHEDULES}/tasks`]: () => Response.json([task]),
    [`GET ${SCHEDULES}/runs/inbox`]: () => Response.json([]),
    [`GET ${SCHEDULES}/tasks/${task.id}/runs`]: () => Response.json(runs()),
    [`POST ${SCHEDULES}/tasks/${task.id}/run`]: posts.answer,
  });
  vi.stubGlobal('fetch', api.fetch);
  renderScheduled(`/scheduled/tasks/${task.id}`);
  return api;
}

it('retries a failed Run now with the same idempotency key', async () => {
  const posts = keyedPosts([
    droppedConnection,
    () => Response.json(manualRun, { status: 202 }),
  ]);
  try {
    const api = renderTaskWithRuns(posts, () => []);

    await runNow();
    expect(await screen.findByText('Action failed')).toBeTruthy();
    await runNow();
    await waitFor(() => expect(screen.queryByText('Action failed')).toBeNull());

    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[0]).toBeTruthy();
    expect(posts.keys[1]).toBe(posts.keys[0]);
    expect(api.unexpected).toEqual([]);
  } finally {
    cleanup();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});

it('sends a new idempotency key for a Run now after one succeeded', async () => {
  const started: ScheduledRunView[] = [];
  const start = (run: ScheduledRunView) => () => {
    started.push(run);
    return Response.json(run, { status: 202 });
  };
  const secondRun = {
    ...manualRun,
    id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  };
  const posts = keyedPosts([start(manualRun), start(secondRun)]);
  const runLink = (run: ScheduledRunView) =>
    document.querySelector(
      `a[href="/scheduled/tasks/${task.id}/runs/${run.id}"]`,
    );
  try {
    const api = renderTaskWithRuns(posts, () => started);

    await runNow();
    await waitFor(() => expect(runLink(manualRun)).not.toBeNull());
    await runNow();
    await waitFor(() => expect(runLink(secondRun)).not.toBeNull());

    expect(posts.keys).toHaveLength(2);
    expect(posts.keys[1]).toBeTruthy();
    expect(posts.keys[1]).not.toBe(posts.keys[0]);
    expect(screen.queryByText('Action failed')).toBeNull();
    expect(api.unexpected).toEqual([]);
  } finally {
    cleanup();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});

const unreadableRuns = {
  'fails on the server': serverError,
  'answers runs that do not match the run view': () =>
    Response.json([{ id: 'run-1' }]),
};

for (const [failure, answer] of Object.entries(unreadableRuns)) {
  it(`says a task's runs are unavailable when the runs request ${failure}`, async () => {
    const api = schedulesApi({
      [`GET ${SCHEDULES}/tasks`]: () => Response.json([task]),
      [`GET ${SCHEDULES}/runs/inbox`]: () => Response.json([]),
      [`GET ${SCHEDULES}/tasks/${task.id}/runs`]: answer,
    });
    vi.stubGlobal('fetch', api.fetch);
    try {
      renderScheduled(`/scheduled/tasks/${task.id}`);

      expect(
        await screen.findByText('Previous runs unavailable.'),
      ).toBeTruthy();
      expect(screen.queryByText('No runs yet.')).toBeNull();
      expect(api.unexpected).toEqual([]);
    } finally {
      cleanup();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
}
