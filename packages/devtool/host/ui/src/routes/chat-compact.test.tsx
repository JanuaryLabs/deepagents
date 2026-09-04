import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';

import { Component as ChatRoute } from './chat.tsx';

afterEach(cleanup);

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
