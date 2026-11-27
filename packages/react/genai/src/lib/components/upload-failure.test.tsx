import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import { APICallError } from 'ai';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  GenaiMessagesProvider,
  ZukhrufChatTransport,
  useAgent,
} from '@deepagents/react-genai';

const msw = new Msw();
const sessions = new URL('/sessions', location.href).href;
const uploads = `${sessions}/chat-1/uploads`;

const failures = [
  {
    status: 413,
    english: 'The file is too large to upload.',
    arabic: 'الملف أكبر من أن يُرفع.',
    body: {
      error: 'Upload is too large',
      cause: {
        code: 'api/payload-too-large',
        detail: 'Upload exceeds 5242880 bytes',
      },
    },
  },
  {
    status: 415,
    english: 'This type of file cannot be uploaded.',
    arabic: 'لا يمكن رفع هذا النوع من الملفات.',
    body: {
      error: 'Unsupported Media Type',
      cause: {
        code: 'zukhruf/unsupported-media-type',
        detail: 'Uploads must be one of image/png, image/jpeg',
      },
    },
  },
  {
    status: 500,
    english: 'Could not upload the file. Try again.',
    arabic: 'تعذّر رفع الملف. حاول مجددًا.',
    body: { error: 'Internal Server Error' },
  },
];

const ar = {
  'composer.attachFiles': 'أرفق ملفات',
  'composer.editor': 'اكتب رسالتك',
  'composer.placeholder': 'اكتب رسالة أو / للأوامر',
  'composer.sendFailed': 'تعذّر إرسال الطلب',
  'composer.attachments': 'الملفات المرفقة بالطلب',
  'composer.uploadTooLarge': 'الملف أكبر من أن يُرفع.',
  'composer.uploadUnsupported': 'لا يمكن رفع هذا النوع من الملفات.',
  'composer.uploadFailed': 'تعذّر رفع الملف. حاول مجددًا.',
  'composer.removeAttachment': ({ label }: { label: string }) => `أزل ${label}`,
  'composer.attachInput': 'أرفق ملفات وسائط',
};

function HostComposer({ onError }: { onError: (error: unknown) => void }) {
  const { submit } = useAgent();
  return (
    <ChatComposer.Provider
      onSubmit={async ({ prompt, persistedPrompt, items }) => {
        try {
          await submit({
            prompt,
            persistedPrompt,
            files: items.flatMap((item) =>
              item.type === 'image' ? [item.file] : [],
            ),
          });
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

function renderChat(chat: ReactNode) {
  return render(
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="chat-1"
        transport={new ZukhrufChatTransport({ api: sessions })}
        onResetChat={() => {}}
      >
        {chat}
      </AgentProvider>
    </ClockProvider>,
  );
}

async function sendImage(attachLabel: string, editorLabel: string) {
  const user = userEvent.setup();
  await user.upload(
    screen.getByLabelText(attachLabel),
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', {
      type: 'image/png',
    }),
  );
  await user.click(screen.getByRole('textbox', { name: editorLabel }));
  await user.keyboard('What is in this picture?{Enter}');
  return (await screen.findByRole('alert')).textContent ?? '';
}

describe.each(failures)(
  'a failed upload in ChatComposer answered $status',
  ({ status, english, arabic, body }) => {
    it(`shows a readable sentence, not the server's code or detail, when the upload answers ${status}`, async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      await using _ = msw.intercept(
        http.post(uploads, () => HttpResponse.json(body, { status })),
      );
      renderChat(<HostComposer onError={() => {}} />);

      const alert = await sendImage(
        'Attach media files',
        'Rich prompt composer',
      );

      expect(alert).toBe(english);
      expect(alert).not.toMatch(
        /HTTP|\{|zukhruf\/|api\/|bytes|image\/png|Upload is too large|Unsupported Media Type|Internal Server Error/,
      );
    });

    it(`shows Arabic words only from GenaiMessagesProvider when the upload answers ${status}`, async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      await using _ = msw.intercept(
        http.post(uploads, () => HttpResponse.json(body, { status })),
      );
      renderChat(
        <GenaiMessagesProvider locale="ar" messages={ar}>
          <HostComposer onError={() => {}} />
        </GenaiMessagesProvider>,
      );

      const alert = await sendImage(
        ar['composer.attachInput'],
        ar['composer.editor'],
      );

      expect(alert).toBe(arabic);
      expect(alert).not.toMatch(/[A-Za-z]/);
    });

    it(`lets the host read the status ${status} and the server's body from the rejected APICallError`, async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      await using _ = msw.intercept(
        http.post(uploads, () => HttpResponse.json(body, { status })),
      );
      const errors: unknown[] = [];
      renderChat(<HostComposer onError={(error) => errors.push(error)} />);

      await sendImage('Attach media files', 'Rich prompt composer');

      expect(errors).toHaveLength(1);
      expect(APICallError.isInstance(errors[0])).toBe(true);
      expect(errors[0]).toMatchObject({
        statusCode: status,
        responseBody: JSON.stringify(body),
      });
    });
  },
);

describe('a submission in ChatComposer that fails for another reason', () => {
  it("shows composer.sendFailed, not the error's message, when the host's submit rejects with an Error that is no APICallError", async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    renderChat(
      <GenaiMessagesProvider locale="ar" messages={ar}>
        <ChatComposer.Provider
          onSubmit={() =>
            Promise.reject(
              new Error('The chat changed before the submission was sent.'),
            )
          }
        >
          <ChatComposer.Root>
            <ChatComposer.Content>
              <ChatComposer.Editor />
              <ChatComposer.Error />
            </ChatComposer.Content>
          </ChatComposer.Root>
        </ChatComposer.Provider>
      </GenaiMessagesProvider>,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole('textbox', { name: ar['composer.editor'] }),
    );
    await user.keyboard('hello{Enter}');

    expect((await screen.findByRole('alert')).textContent).toBe(
      ar['composer.sendFailed'],
    );
  });
});
