import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  type UIMessage,
  type UIMessageChunk,
  createUIMessageStreamResponse,
} from 'ai';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { CompactionEvent } from '@deepagents/experimental/zukhruf';

import { Component as ChatRoute } from './chat.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const messages = [
  {
    id: 'user-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Help me choose.' }],
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-bash',
        toolCallId: 'bash-1',
        state: 'output-available',
        input: { command: 'printf hello', reasoning: 'Show the demo output' },
        output: { stdout: 'hello', stderr: '', exitCode: 0 },
      },
      {
        type: 'tool-readFile',
        toolCallId: 'read-1',
        state: 'output-available',
        input: { path: 'notes.md', offset: 4, limit: 2 },
        output: { type: 'text', value: '# Notes\nReusable content' },
      },
      {
        type: 'tool-writeFile',
        toolCallId: 'write-1',
        state: 'output-available',
        input: { path: 'result.md', content: '# Result' },
        output: { success: true },
      },
      { type: 'text', text: 'Done.' },
    ],
  },
] satisfies UIMessage[];

it('renders the Devtool transcript through the compact trajectory', async () => {
  const router = createMemoryRouter(
    [
      {
        path: '/chat',
        Component: ChatRoute,
        loader: () => ({
          chatId: 'chat-1',
          discovery: { capabilities: { chat: { href: '/api/chat' } } },
          history: [],
          historyError: false,
          initialMessages: messages,
          sessionError: false,
          sessionExists: false,
        }),
      },
    ],
    { initialEntries: ['/chat'] },
  );

  render(<RouterProvider router={router} />);

  const activity = await screen.findByRole('button', {
    name: /Ran 3 tools/,
  });
  fireEvent.click(activity);
  const bash = screen.getByRole('button', { name: /^Bash/ });
  const readFile = screen.getByRole('button', { name: /^ReadFile/ });
  const writeFile = screen.getByRole('button', { name: /^WriteFile/ });

  fireEvent.click(bash);
  expect(screen.getByText('Command exited with code 0.')).toBeTruthy();
  expect(screen.getByText('Standard output')).toBeTruthy();
  expect(screen.getAllByText('hello').length).toBeGreaterThan(0);

  fireEvent.click(readFile);
  expect(screen.getByText('lines 4-5')).toBeTruthy();
  expect(screen.getAllByText(/Reusable content/).length).toBeGreaterThan(0);

  fireEvent.click(writeFile);
  expect(screen.getByText('File written.')).toBeTruthy();
  expect(screen.getByText('Written content')).toBeTruthy();
  expect(screen.getByText('Done.')).toBeTruthy();
  expect(document.querySelector('[data-slot="agent"]')?.className).toContain(
    "**:data-[slot='content']:max-w-3xl",
  );
});

const started = {
  id: 'compact-1',
  status: 'started',
  tokenScope: 'request',
  triggerIndex: 1,
  tokensBefore: 2_000,
  targetTokens: 4_000,
  messageCount: 41,
} satisfies CompactionEvent;
const completed = {
  id: 'compact-1',
  status: 'completed',
  tokenScope: 'request',
  tokens: { before: 2_000, after: 900 },
  replacedRange: { start: 0, end: 37 },
  usage: undefined,
} satisfies CompactionEvent;
const eventPart = (data: CompactionEvent) => ({
  type: 'data-compaction' as const,
  id: `${data.id}:${data.status}`,
  data,
});

function renderConversation(
  initialMessages: UIMessage[],
  sessionExists: boolean,
) {
  const router = createMemoryRouter(
    [
      {
        path: '/chat',
        Component: ChatRoute,
        loader: () => ({
          chatId: 'chat-compaction',
          discovery: { capabilities: { chat: { href: '/api/chat' } } },
          initialMessages,
          sessionExists,
          sessionError: false,
        }),
      },
    ],
    { initialEntries: ['/chat'] },
  );
  return render(<RouterProvider router={router} />);
}

it('shows live compaction, one completed entry on replay, and its details after reopening', async () => {
  const { readable, writable } = new TransformStream<UIMessageChunk>();
  const writer = writable.getWriter();
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(createUIMessageStreamResponse({ stream: readable }));
  vi.stubGlobal('fetch', request);
  const initial: UIMessage[] = [
    {
      id: 'request',
      role: 'user',
      parts: [{ type: 'text', text: 'Continue' }],
    },
  ];
  const view = renderConversation(initial, true);
  await writer.write({ type: 'start', messageId: 'response' });
  await writer.write(eventPart(started));
  expect(await screen.findByText('Compacting context…')).toBeTruthy();
  expect(
    screen.getByRole('status', { name: 'Compacting context' }),
  ).toBeTruthy();
  await writer.write(eventPart(completed));
  await writer.write(eventPart(completed));
  await writer.write({ type: 'finish' });
  await writer.close();
  const compacted = await screen.findByRole('button', {
    name: /Context compacted/,
  });
  expect(screen.getAllByText('Context compacted')).toHaveLength(1);
  expect(screen.getByText('2,000 → 900 estimated input tokens')).toBeTruthy();
  fireEvent.click(compacted);
  expect(await screen.findByText('41')).toBeTruthy();
  expect(screen.getByText('4,000 tokens')).toBeTruthy();
  expect(screen.getByText('Estimated input target')).toBeTruthy();
  expect(screen.getByText('#2')).toBeTruthy();
  expect(screen.getByText('Saved')).toBeTruthy();
  view.unmount();
  renderConversation(
    [
      ...initial,
      {
        id: 'response',
        role: 'assistant',
        parts: [eventPart(started), eventPart(completed)],
      },
    ],
    false,
  );
  expect(
    await screen.findByRole('button', { name: /Context compacted/ }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('status', { name: 'Compacting context' }),
  ).toBeNull();
});

it('shows failed, interrupted, and restored compactions from the saved transcript', async () => {
  renderConversation(
    [
      {
        id: 'failed',
        role: 'assistant',
        parts: [
          eventPart(started),
          eventPart({
            id: started.id,
            status: 'failed',
            phase: 'compact',
            reason: 'empty-summary',
          }),
        ],
      },
      {
        id: 'interrupted',
        role: 'assistant',
        parts: [eventPart(started)],
      },
      {
        id: 'restored',
        role: 'assistant',
        parts: [
          eventPart({
            id: 'restore',
            status: 'restored',
            sourceMessages: 37,
            replacementMessages: 1,
          }),
        ],
      },
    ],
    false,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Compaction failed' }),
  );
  expect((await screen.findByRole('alert')).textContent).toContain(
    'compact: empty-summary',
  );
  expect(screen.getByText('Compaction interrupted')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Using saved summary' }));
  expect(await screen.findByText('37 → 1 messages')).toBeTruthy();
});

it('keeps historical message counts distinct from new input estimates', async () => {
  const { tokenScope: _startedScope, ...historicalStarted } = started;
  const { tokenScope: _completedScope, ...historicalCompleted } = completed;
  renderConversation(
    [
      {
        id: 'historical',
        role: 'assistant',
        parts: [eventPart(historicalStarted), eventPart(historicalCompleted)],
      },
    ],
    false,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: /Context compacted/ }),
  );
  expect(screen.getByText('2,000 → 900 estimated message tokens')).toBeTruthy();
  expect(screen.getByText('Estimated message target')).toBeTruthy();
  expect(screen.queryByText('Estimated input target')).toBeNull();
});
