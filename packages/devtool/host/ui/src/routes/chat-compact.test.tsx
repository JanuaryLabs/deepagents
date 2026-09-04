import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';

import { Component as ChatRoute } from './chat.tsx';

afterEach(cleanup);

const question = {
  type: 'choice' as const,
  question: 'Which option?',
  multiSelect: false,
  options: [{ label: 'One' }],
};

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
        type: 'tool-ask_user_question',
        toolCallId: 'question-1',
        state: 'output-available',
        input: { questions: [question] },
        output: { answers: [] },
      },
      {
        type: 'tool-ask_user_question',
        toolCallId: 'question-2',
        state: 'output-available',
        input: { questions: [question] },
        output: { answers: [] },
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

  expect(
    await screen.findByRole('button', { name: /Ran 2 tools/ }),
  ).toBeTruthy();
  expect(screen.getByText('Done.')).toBeTruthy();
  expect(document.querySelector('[data-slot="agent"]')?.className).toContain(
    "**:data-[slot='content']:max-w-3xl",
  );
});
