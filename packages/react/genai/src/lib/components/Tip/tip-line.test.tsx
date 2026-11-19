import { createClock } from '@sinonjs/fake-timers';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ClockProvider } from '@zukhruf/ui';
import { expect, test } from 'vitest';

import { TipLine, TipValueContext } from '@deepagents/react-genai';

test('a new tip shimmers for 1.5 seconds of the host clock', () => {
  const clock = createClock();
  try {
    const { rerender } = render(
      <ClockProvider clock={clock}>
        <TipValueContext value="first">
          <TipLine />
        </TipValueContext>
      </ClockProvider>,
    );

    rerender(
      <ClockProvider clock={clock}>
        <TipValueContext value="second">
          <TipLine />
        </TipValueContext>
      </ClockProvider>,
    );

    const tip = screen.getByText('Tip: second');
    expect(tip).toHaveClass('shimmer');

    act(() => {
      clock.tick(1499);
    });

    expect(tip).toHaveClass('shimmer');

    act(() => {
      clock.tick(1);
    });

    expect(tip).not.toHaveClass('shimmer');
  } finally {
    cleanup();
  }
});
