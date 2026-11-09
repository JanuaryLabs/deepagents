import { createClock } from '@sinonjs/fake-timers';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { UIMessage } from 'ai';
import { expect, test, vi } from 'vitest';

import { AssistantSnapshot } from '@deepagents/react-genai';

const message: UIMessage = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'The answer is 42.' }],
};

test('the clock of the host runs the spinner delay of the copy button', async () => {
  const clock = createClock();
  const { promise: clipboardWrite, resolve: finishWrite } =
    Promise.withResolvers<void>();
  // A text copy stays in progress for as long as the clipboard holds this
  // promise. Without write, the hook does not draw the image, which happy-dom
  // can not do.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => clipboardWrite },
  });
  try {
    const { container } = render(
      <ClockProvider clock={clock}>
        <AssistantSnapshot
          message={message}
          renderContent={() => 'The answer is 42.'}
        />
      </ClockProvider>,
    );

    await userEvent.click(
      screen.getByRole('button', { name: 'Copy snapshot' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Copying snapshot' }),
    ).toBeDisabled();
    // An icon button keeps its spinner in the DOM and fades it in.
    const spinner = container.querySelector('.animate-spin')?.parentElement;
    expect(spinner).toHaveClass('opacity-0');

    act(() => {
      clock.tick(300);
    });

    expect(spinner).toHaveClass('opacity-100');

    finishWrite();

    expect(
      await screen.findByRole('button', { name: 'Copied text' }),
    ).toBeEnabled();
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
    cleanup();
  }
});

test('with no ClockProvider in the host, the copy button throws at its first render', () => {
  // React reports the render error on console.error before it throws. The
  // assertion reads the error, so this only keeps the expected report out of
  // the output.
  const consoleError = vi.spyOn(console, 'error').mockReturnValue();
  try {
    expect(() =>
      render(
        <AssistantSnapshot
          message={message}
          renderContent={() => 'The answer is 42.'}
        />,
      ),
    ).toThrow('No clock set, use ClockProvider to set one');
  } finally {
    consoleError.mockRestore();
    cleanup();
  }
});
