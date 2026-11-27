import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import { expect, test } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  ZukhrufChatTransport,
} from '@deepagents/react-genai';

function renderComposer() {
  return render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="chat-1"
        transport={new ZukhrufChatTransport({ api: '/sessions' })}
        onResetChat={() => {}}
      >
        <ChatComposer.Provider>
          <ChatComposer.Root>
            <ChatComposer.Content>
              <ChatComposer.Attachments />
              <ChatComposer.Editor placeholder="Message" />
            </ChatComposer.Content>
            <ChatComposer.Toolbar>
              <ChatComposer.AttachFiles />
            </ChatComposer.Toolbar>
          </ChatComposer.Root>
        </ChatComposer.Provider>
      </AgentProvider>
    </ClockProvider>,
  );
}

test('AttachFiles exposes a hidden media file input and Attachments lists what was attached', async () => {
  const user = userEvent.setup();
  try {
    renderComposer();
    expect(
      screen.getByRole('button', { name: 'Attach files' }),
    ).toBeInTheDocument();
    const input = screen.getByLabelText<HTMLInputElement>('Attach media files');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*,video/*,audio/*');
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();

    await user.upload(input, [
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
        type: 'image/png',
      }),
      new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], 'clip.mp4', {
        type: 'video/mp4',
      }),
    ]);

    const strip = screen.getByRole('list', { name: 'Attached files' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(strip).getByRole('button', { name: 'Remove [Image #1]' }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: 'Remove [Video #2]' }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a file over maxUploadBytes is refused with the size in words and attaches nothing', async () => {
  const user = userEvent.setup();
  try {
    render(
      <ClockProvider clock={createClock()}>
        <AgentProvider
          chatId="chat-1"
          transport={new ZukhrufChatTransport({ api: '/sessions' })}
          onResetChat={() => {}}
        >
          <ChatComposer.Provider maxUploadBytes={5_000_000}>
            <ChatComposer.Root>
              <ChatComposer.Content>
                <ChatComposer.Attachments />
                <ChatComposer.Editor placeholder="Message" />
                <ChatComposer.Error />
              </ChatComposer.Content>
              <ChatComposer.Toolbar>
                <ChatComposer.AttachFiles />
              </ChatComposer.Toolbar>
            </ChatComposer.Root>
          </ChatComposer.Provider>
        </AgentProvider>
      </ClockProvider>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Attach media files');

    await user.upload(
      input,
      new File([new Uint8Array(5_000_001)], 'scan.png', { type: 'image/png' }),
    );
    const named = (await screen.findByRole('alert')).textContent;
    await user.upload(
      input,
      new File([new Uint8Array(5_000_001)], '', { type: 'image/png' }),
    );

    expect({
      named,
      unnamed: screen.getByRole('alert').textContent,
      attached: screen.queryByRole('list', { name: 'Attached files' }),
    }).toEqual({
      named: 'Files over 5 MB cannot be attached: scan.png',
      unnamed: 'Files over 5 MB cannot be attached: unnamed file',
      attached: null,
    });
  } finally {
    cleanup();
  }
});
