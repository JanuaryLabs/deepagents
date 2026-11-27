import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  Composer,
  useComposerDictation,
} from '@deepagents/react-input/browser';

import { editorWords, rootWords } from '../testing/english-words.ts';
import { FakeClock } from '../testing/fake-clock.tsx';

function ReadsDictation() {
  useComposerDictation('ReadsDictation');
  return null;
}

function DictationShortcut() {
  const { state, start } = useComposerDictation('DictationShortcut');
  return (
    <button type="button" onClick={start}>
      {`Shortcut dictation ${state.status}`}
    </button>
  );
}

describe('Composer dictation', () => {
  it('offers no dictation in a browser without a recorder', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <Composer.Root
        {...rootWords}
        dictation={{ transcribe: async () => ({ text: 'never heard' }) }}
      >
        <Composer.Editor {...editorWords} />
        <Composer.Toolbar>
          <Composer.Dictate
            render={(props, dictation) => (
              <button {...props}>
                {dictation.status === 'unavailable'
                  ? `Dictation unavailable: ${dictation.reason}`
                  : `Dictation ${dictation.status}`}
              </button>
            )}
          />
        </Composer.Toolbar>
      </Composer.Root>,
      { wrapper: FakeClock },
    );

    const dictate = await screen.findByRole('button', {
      name: 'Dictation unavailable: unsupported',
    });
    expect(dictate).toBeDisabled();
    expect(dictate).toHaveAttribute('data-status', 'unavailable');
  });

  it('ignores a host start in a browser without a recorder', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const user = userEvent.setup();
    const rejections: unknown[] = [];
    const recordRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', recordRejection);
    try {
      render(
        <Composer.Root
          {...rootWords}
          dictation={{ transcribe: async () => ({ text: 'never heard' }) }}
        >
          <Composer.Editor {...editorWords} />
          <Composer.Toolbar>
            <DictationShortcut />
          </Composer.Toolbar>
        </Composer.Root>,
        { wrapper: FakeClock },
      );

      await user.click(
        await screen.findByRole('button', {
          name: 'Shortcut dictation unavailable',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toEqual([]);
      expect(
        screen.getByRole('button', { name: 'Shortcut dictation unavailable' }),
      ).toBeInTheDocument();
    } finally {
      process.off('unhandledRejection', recordRejection);
    }
  });

  it.each([
    ['Composer.Dictate', <Composer.Dictate key="dictate" />],
    ['Composer.CancelDictation', <Composer.CancelDictation key="cancel" />],
    ['ReadsDictation', <ReadsDictation key="hook" />],
  ])('%s needs the dictation of Composer.Root', (name, part) => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    expect(() =>
      render(
        <Composer.Root {...rootWords}>
          <Composer.Editor {...editorWords} />
          <Composer.Toolbar>{part}</Composer.Toolbar>
        </Composer.Root>,
        { wrapper: FakeClock },
      ),
    ).toThrow(`${name} needs the dictation prop of Composer.Root.`);
  });
});
