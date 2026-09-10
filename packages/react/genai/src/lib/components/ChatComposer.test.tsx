import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  ZukhrufChatTransport,
} from '@deepagents/react-genai';

function renderComposer() {
  return render(
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
    </AgentProvider>,
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
