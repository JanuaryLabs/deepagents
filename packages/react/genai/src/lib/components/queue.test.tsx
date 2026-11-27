import { cleanup, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';

import { MessageQueue } from '@deepagents/react-genai';

it('draws a queued prompt skill reference with the package icon', () => {
  using stack = new DisposableStack();
  stack.defer(cleanup);

  render(
    <MessageQueue.Text>
      Use [$Revenue Analysis](skill://skill-123) for Q2.
    </MessageQueue.Text>,
  );

  const skill = screen.getByText('Revenue Analysis').closest('[data-skill-id]');
  expect({
    skillId: skill?.getAttribute('data-skill-id'),
    icons: Array.from(skill?.querySelectorAll('svg') ?? [], (icon) =>
      icon.getAttribute('class'),
    ),
  }).toEqual({
    skillId: 'skill-123',
    icons: ['lucide lucide-package size-3.5 self-center'],
  });
});
