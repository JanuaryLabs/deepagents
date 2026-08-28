import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Composer } from '@deepagents/react-input/browser';

function DraftScenario({
  draftKey,
  send = () => Promise.resolve(),
}: {
  draftKey: string;
  send?: () => Promise<unknown>;
}) {
  return (
    <Composer.Root draftKey={draftKey} onSubmit={() => send()}>
      <Composer.Content>
        <Composer.Editor />
      </Composer.Content>
    </Composer.Root>
  );
}

function promptElement() {
  return screen.getByRole<HTMLElement>('textbox', {
    name: /rich prompt composer/i,
  });
}

describe('Composer.Root draftKey', () => {
  it('restores the persisted draft after a remount', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const first = render(<DraftScenario draftKey="chat-1" />);
      await user.click(promptElement());
      await user.keyboard('hello draft');
      first.unmount();

      render(<DraftScenario draftKey="chat-1" />);

      expect(promptElement()).toHaveTextContent('hello draft');
    } finally {
      localStorage.clear();
    }
  });

  it('keeps drafts isolated per key', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const first = render(<DraftScenario draftKey="chat-1" />);
      await user.click(promptElement());
      await user.keyboard('first');
      first.unmount();

      const second = render(<DraftScenario draftKey="chat-2" />);
      expect(promptElement()).not.toHaveTextContent('first');
      await user.click(promptElement());
      await user.keyboard('second');
      second.unmount();

      render(<DraftScenario draftKey="chat-1" />);

      expect(promptElement()).toHaveTextContent('first');
      expect(promptElement()).not.toHaveTextContent('second');
    } finally {
      localStorage.clear();
    }
  });

  it('switches drafts when the key changes without a host remount', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const view = render(<DraftScenario draftKey="chat-1" />);
      await user.click(promptElement());
      await user.keyboard('first');

      view.rerender(<DraftScenario draftKey="chat-2" />);
      expect(promptElement()).not.toHaveTextContent('first');
      await user.click(promptElement());
      await user.keyboard('second');

      view.rerender(<DraftScenario draftKey="chat-1" />);

      expect(promptElement()).toHaveTextContent('first');
    } finally {
      localStorage.clear();
    }
  });

  it('clears the stored draft when the editor is emptied', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      render(<DraftScenario draftKey="chat-1" />);
      await user.click(promptElement());
      await user.keyboard('temporary');
      expect(localStorage.length).toBe(1);

      await user.keyboard('{Control>}a{/Control}{Backspace}');

      expect(localStorage.length).toBe(0);
    } finally {
      localStorage.clear();
    }
  });

  it('clears the stored draft when a submission returns no promise', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      render(
        <Composer.Root draftKey="chat-1" onSubmit={() => undefined}>
          <Composer.Content>
            <Composer.Editor />
          </Composer.Content>
        </Composer.Root>,
      );
      await user.click(promptElement());
      await user.keyboard('fire and forget');
      expect(localStorage.length).toBe(1);

      await user.keyboard('{Enter}');

      await waitFor(() => expect(localStorage.length).toBe(0));
    } finally {
      localStorage.clear();
    }
  });

  it('keeps the stored draft until the send settles and clears it on success', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const { promise, resolve } = Promise.withResolvers<void>();
      render(
        <DraftScenario draftKey="chat-1" send={() => promise} />,
      );
      await user.click(promptElement());
      await user.keyboard('mid flight');
      await user.keyboard('{Enter}');

      expect(promptElement()).not.toHaveTextContent('mid flight');
      expect(localStorage.length).toBe(1);

      await act(async () => resolve());

      await waitFor(() => expect(localStorage.length).toBe(0));
    } finally {
      localStorage.clear();
    }
  });

  it('restores the draft into the editor and focuses it when the send fails', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const { promise, reject } = Promise.withResolvers<never>();
      render(
        <DraftScenario draftKey="chat-1" send={() => promise} />,
      );
      await user.click(promptElement());
      await user.keyboard('will fail');
      await user.keyboard('{Enter}');
      expect(promptElement()).not.toHaveTextContent('will fail');

      await act(async () => reject(new Error('offline')));

      await waitFor(() =>
        expect(promptElement()).toHaveTextContent('will fail'),
      );
      expect(promptElement()).toHaveFocus();
      expect(localStorage.length).toBe(1);
    } finally {
      localStorage.clear();
    }
  });

  it('ignores corrupted or foreign stored values', async () => {
    try {
      localStorage.clear();
      const user = userEvent.setup();
      const seeded = render(<DraftScenario draftKey="chat-1" />);
      await user.click(promptElement());
      await user.keyboard('about to corrupt');
      const [storageKey] = Object.keys(localStorage);
      if (!storageKey) throw new Error('Expected persisted draft key');
      seeded.unmount();

      localStorage.setItem(storageKey, '{not json');
      const corrupted = render(<DraftScenario draftKey="chat-1" />);
      expect(promptElement()).not.toHaveTextContent('about to corrupt');
      corrupted.unmount();

      localStorage.setItem(storageKey, JSON.stringify({ foo: 1 }));
      render(<DraftScenario draftKey="chat-1" />);

      expect(promptElement()).not.toHaveTextContent('about to corrupt');
    } finally {
      localStorage.clear();
    }
  });
});
