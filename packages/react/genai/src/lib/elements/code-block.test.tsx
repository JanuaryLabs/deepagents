import { createClock } from '@sinonjs/fake-timers';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import { expect, test } from 'vitest';

import { CodeBlock, CodeBlockCopyButton } from '@deepagents/react-genai';

test('the copy button shows its check for the timeout of the host clock, then the copy icon again', async () => {
  const clock = createClock();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
  try {
    const { container } = render(
      <ClockProvider clock={clock}>
        <CodeBlock code="select 1" language="sql">
          <CodeBlockCopyButton aria-label="Copy code" />
        </CodeBlock>
      </ClockProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(container.querySelector('svg.lucide-check')).toBeInTheDocument();

    act(() => {
      clock.tick(1999);
    });

    expect(container.querySelector('svg.lucide-check')).toBeInTheDocument();

    act(() => {
      clock.tick(1);
    });

    expect(container.querySelector('svg.lucide-check')).toBeNull();
    expect(container.querySelector('svg.lucide-copy')).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
    cleanup();
  }
});
