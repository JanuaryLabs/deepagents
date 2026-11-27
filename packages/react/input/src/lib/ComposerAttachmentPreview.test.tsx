import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Composer } from '@deepagents/react-input/browser';

import {
  attachFilesWords,
  attachmentsWords,
  editorWords,
  rootWords,
} from '../testing/english-words.ts';
import { FakeClock } from '../testing/fake-clock.tsx';

function StrictClock({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <FakeClock>{children}</FakeClock>
    </StrictMode>
  );
}

function renderComposer(onSubmit: () => Promise<void>) {
  return render(
    <Composer.Root {...rootWords} onSubmit={onSubmit}>
      <Composer.Content>
        <Composer.AttachFiles {...attachFilesWords}>
          Attach
        </Composer.AttachFiles>
        <Composer.Attachments {...attachmentsWords} />
        <Composer.Editor {...editorWords} />
        <Composer.Error />
      </Composer.Content>
    </Composer.Root>,
    { wrapper: StrictClock },
  );
}

/** Each image inserted into an attachment that was already on screen without it. */
function watchLateImages(container: HTMLElement) {
  const late: string[] = [];
  const record = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      if (
        mutation.target instanceof Element &&
        mutation.target.matches('[role=listitem]')
      ) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLImageElement) late.push(node.alt);
        }
      }
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(container, { subtree: true, childList: true });
  return {
    late() {
      record(observer.takeRecords());
      return late;
    },
    [Symbol.dispose]: () => observer.disconnect(),
  };
}

describe('the attachment preview', () => {
  it('draws the image together with its remove button when the image is attached', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    stack.defer(() => revokeObjectUrl.mockRestore());

    const user = userEvent.setup();
    const { container } = renderComposer(() => Promise.resolve());
    using watch = watchLateImages(container);

    await user.upload(
      screen.getByLabelText(attachFilesWords.inputLabel),
      new File(['bytes'], 'chart.png', { type: 'image/png' }),
    );

    const image = await screen.findByRole<HTMLImageElement>('img', {
      name: '[Image #1]',
    });
    expect(
      screen.getByRole('button', { name: 'Remove [Image #1]' }),
    ).toBeInTheDocument();
    expect(watch.late()).toEqual([]);
    expect(image.src).toMatch(/^blob:/);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(image.src);
  });

  it('brings back the same image, without a reload, with its remove button when the send fails', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    stack.defer(() => revokeObjectUrl.mockRestore());

    const { promise, reject } = Promise.withResolvers<void>();
    const user = userEvent.setup();
    const { container } = renderComposer(() => promise);
    await user.upload(
      screen.getByLabelText(attachFilesWords.inputLabel),
      new File(['bytes'], 'retry.png', { type: 'image/png' }),
    );
    const sentSrc = (
      await screen.findByRole<HTMLImageElement>('img', { name: '[Image #1]' })
    ).src;
    using watch = watchLateImages(container);

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await act(async () => reject(new Error('offline')));
    await screen.findByRole('alert');

    const restored = screen.getByRole<HTMLImageElement>('img', {
      name: '[Image #1]',
    });
    expect(
      screen.getByRole('button', { name: 'Remove [Image #1]' }),
    ).toBeInTheDocument();
    expect(watch.late()).toEqual([]);
    expect(restored.src).toBe(sentSrc);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(sentSrc);
  });

  it('lets go of the image once the send succeeds', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    stack.defer(() => revokeObjectUrl.mockRestore());

    const { promise, resolve } = Promise.withResolvers<void>();
    const user = userEvent.setup();
    renderComposer(() => promise);
    await user.upload(
      screen.getByLabelText(attachFilesWords.inputLabel),
      new File(['bytes'], 'sent.png', { type: 'image/png' }),
    );
    const sentSrc = (
      await screen.findByRole<HTMLImageElement>('img', { name: '[Image #1]' })
    ).src;

    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Enter}');
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(sentSrc);
    await act(async () => resolve());

    expect(revokeObjectUrl).toHaveBeenCalledWith(sentSrc);
  });
});
