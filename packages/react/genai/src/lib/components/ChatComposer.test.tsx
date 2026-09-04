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
            <ChatComposer.AttachedImages />
            <ChatComposer.Editor placeholder="Message" />
          </ChatComposer.Content>
          <ChatComposer.Toolbar>
            <ChatComposer.AttachImage />
          </ChatComposer.Toolbar>
        </ChatComposer.Root>
      </ChatComposer.Provider>
    </AgentProvider>,
  );
}

test('AttachImage exposes a hidden image file input and AttachedImages lists what was attached', async () => {
  const user = userEvent.setup();
  try {
    renderComposer();
    expect(
      screen.getByRole('button', { name: 'Attach image' }),
    ).toBeInTheDocument();
    const input = screen.getByLabelText<HTMLInputElement>('Attach image files');
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(screen.queryByRole('list', { name: 'Attached images' })).toBeNull();

    await user.upload(
      input,
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
        type: 'image/png',
      }),
    );

    const strip = screen.getByRole('list', { name: 'Attached images' });
    expect(within(strip).getAllByRole('listitem')).toHaveLength(1);
    expect(
      within(strip).getByRole('button', { name: 'Remove [Image #1]' }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
  }
});
