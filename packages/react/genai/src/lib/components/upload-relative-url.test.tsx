import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import { APICallError } from 'ai';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  ZukhrufChatTransport,
  useAgent,
} from '@deepagents/react-genai';

const msw = new Msw();
const sessions = new URL('/sessions', location.href).href;
const session = `${sessions}/chat-1`;
const uploads = `${session}/uploads`;

function receipt(url: string) {
  return {
    path: '/workspace/uploads/x.png',
    name: 'photo.png',
    mediaType: 'image/png',
    size: 4,
    url,
  };
}

function HostComposer({ onError }: { onError: (error: unknown) => void }) {
  const { submit } = useAgent();
  return (
    <ChatComposer.Provider
      onSubmit={async ({ prompt, persistedPrompt, files }) => {
        try {
          await submit({ prompt, persistedPrompt, files });
        } catch (error) {
          onError(error);
          throw error;
        }
      }}
    >
      <ChatComposer.Root>
        <ChatComposer.Content>
          <ChatComposer.Attachments />
          <ChatComposer.Editor />
          <ChatComposer.Error />
        </ChatComposer.Content>
        <ChatComposer.Toolbar>
          <ChatComposer.AttachFiles />
        </ChatComposer.Toolbar>
      </ChatComposer.Root>
    </ChatComposer.Provider>
  );
}

function renderChat(onError: (error: unknown) => void) {
  return render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="chat-1"
        transport={new ZukhrufChatTransport({ api: sessions })}
        onResetChat={() => {}}
      >
        <HostComposer onError={onError} />
      </AgentProvider>
    </ClockProvider>,
  );
}

async function sendImage() {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText('Attach media files'),
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', {
      type: 'image/png',
    }),
  );
  await user.click(
    screen.getByRole('textbox', { name: 'Rich prompt composer' }),
  );
  await user.keyboard('What is in this picture?{Enter}');
}

describe('an upload receipt that breaks the receipt contract', () => {
  it('shows composer.uploadFailed and sends no turn when the receipt url is relative', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const sent: string[] = [];
    await using _ = msw.intercept(
      http.post(uploads, () =>
        HttpResponse.json(receipt('/session/s/uploads/x.png'), { status: 201 }),
      ),
      http.post(session, async ({ request }) => {
        sent.push(await request.text());
        return HttpResponse.json(
          { ok: true, sessionId: 'chat-1', turnId: 'turn-1' },
          { status: 202 },
        );
      }),
    );
    const errors: unknown[] = [];
    renderChat((error) => errors.push(error));

    await sendImage();

    const alert = (await screen.findByRole('alert')).textContent;
    await waitFor(() => expect(errors).toHaveLength(1));
    expect({
      alert,
      apiCallError: APICallError.isInstance(errors[0]),
      sent: sent.length,
    }).toStrictEqual({
      alert: 'Could not upload the file. Try again.',
      apiCallError: true,
      sent: 0,
    });
  });
});
