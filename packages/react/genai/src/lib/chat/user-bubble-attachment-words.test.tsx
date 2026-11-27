import { createClock } from '@sinonjs/fake-timers';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Msw } from '@zukhruf/testing/msw';
import { ClockProvider } from '@zukhruf/ui';
import type { UIMessage } from 'ai';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  AgentProvider,
  ChatComposer,
  CompactMessages,
  GenaiMessagesProvider,
  ZukhrufChatTransport,
  clearPrefill,
  useAgent,
  useAgentMessages,
  writePrefill,
} from '@deepagents/react-genai';
import { Composer } from '@deepagents/react-input/browser';

const msw = new Msw();
const sessions = new URL('/sessions', location.href).href;

const ar = {
  'composer.attachFiles': 'أرفق ملفات',
  'composer.editor': 'اكتب رسالتك',
  'composer.placeholder': 'اكتب رسالة أو / للأوامر',
  'composer.attachments': 'الملفات المرفقة بالطلب',
  'composer.attachInput': 'أرفق ملفات وسائط',
  'message.attachments': 'المرفقات',
  'composer.pastedText': ({ chars }: { chars: number }) =>
    `[نص ملصق · ${chars.toLocaleString('en')} حرف]`,
};

const languages = [
  {
    name: 'English',
    locale: undefined,
    attachInput: 'Attach media files',
    editor: 'Rich prompt composer',
    question: 'What is the potassium value?',
    attachments: 'Attached files',
  },
  {
    name: 'Arabic',
    locale: 'ar',
    attachInput: ar['composer.attachInput'],
    editor: ar['composer.editor'],
    question: 'ما قيمة البوتاسيوم؟',
    attachments: ar['message.attachments'],
  },
] as const;

/** Zukhruf's session routes: the upload receipt, the 202 of a turn, and a stream that answers 'The answer.'. */
function zukhruf() {
  return [
    http.post(`${sessions}/:sessionId/uploads`, async ({ params, request }) => {
      const name = decodeURIComponent(
        request.headers.get('x-upload-filename') ?? '',
      );
      const sessionId = String(params.sessionId);
      return HttpResponse.json(
        {
          path: `/workspace/.uploads/${sessionId}/${name}`,
          name,
          mediaType: request.headers.get('content-type'),
          size: (await request.arrayBuffer()).byteLength,
          url: `https://uploads.test/${sessionId}/${name}`,
        },
        { status: 201 },
      );
    }),
    http.post(`${sessions}/:sessionId`, ({ params }) =>
      HttpResponse.json(
        { ok: true, sessionId: params.sessionId, turnId: 'turn-1' },
        { status: 202 },
      ),
    ),
    http.get(
      `${sessions}/:sessionId/stream`,
      () =>
        new HttpResponse(
          [
            { type: 'start' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'The answer.' },
            { type: 'text-end', id: 't1' },
            { type: 'finish' },
          ]
            .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
            .join('') + 'data: [DONE]\n\n',
          {
            headers: {
              'content-type': 'text/event-stream',
              'x-vercel-ai-ui-message-stream': 'v1',
            },
          },
        ),
    ),
  ];
}

/** The user messages the chat POSTed to start a turn, in order. */
async function postedMessages(requests: readonly Request[]) {
  const turns = requests.filter(
    (request) =>
      request.method === 'POST' &&
      !request.url.endsWith('/cancel') &&
      !request.url.endsWith('/uploads'),
  );
  return Promise.all(
    turns.map(async (request) => {
      const body: { message: UIMessage<{ persistedPrompt: string }> } =
        await request.clone().json();
      return body.message;
    }),
  );
}

/** The chat as a host draws it: every message through CompactMessages, then the composer submitting as devtool and Meddit do. */
function HostChat({ commands }: { commands?: ReactNode }) {
  const { submit } = useAgent();
  const { messages, status } = useAgentMessages();
  return (
    <>
      <CompactMessages.Root messages={messages} status={status}>
        <CompactMessages.List>
          {messages.map((message, index) => (
            <CompactMessages.Item
              key={message.id}
              message={message}
              index={index}
            >
              {message.role === 'user' ? (
                <CompactMessages.UserBubble />
              ) : (
                <CompactMessages.AssistantContent />
              )}
            </CompactMessages.Item>
          ))}
        </CompactMessages.List>
      </CompactMessages.Root>
      <ChatComposer.Provider
        onSubmit={({ prompt, persistedPrompt, files }) =>
          submit({ prompt, persistedPrompt, files })
        }
      >
        {commands}
        <ChatComposer.Root>
          <ChatComposer.Content>
            <ChatComposer.Attachments />
            <ChatComposer.Editor />
          </ChatComposer.Content>
          <ChatComposer.Toolbar>
            <ChatComposer.AttachFiles />
          </ChatComposer.Toolbar>
        </ChatComposer.Root>
      </ChatComposer.Provider>
    </>
  );
}

function renderChat(
  chatId: string,
  locale: string | undefined,
  commands?: ReactNode,
) {
  const chat: ReactNode = (
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId={chatId}
        transport={new ZukhrufChatTransport({ api: sessions })}
        onResetChat={() => {}}
      >
        <HostChat commands={commands} />
      </AgentProvider>
    </ClockProvider>
  );
  return render(
    locale ? (
      <GenaiMessagesProvider locale={locale} messages={ar}>
        {chat}
      </GenaiMessagesProvider>
    ) : (
      chat
    ),
  );
}

/** The text the user bubble holding the question draws, once the answer arrived. */
async function userBubbleText(question: string) {
  await screen.findByText('The answer.');
  const words = await screen.findByText(question, { exact: false });
  return words.closest('[dir="auto"]')?.textContent;
}

describe.each(languages)(
  'a user bubble of a message with an image, in $name (#6316)',
  ({ locale, attachInput, editor, question, attachments }) => {
    it('a message the composer sends with an image and words shows the words, without the [Image #1] the model reads', async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      await using _ = msw.intercept(...zukhruf());
      renderChat(`chat-submit-${locale ?? 'en'}`, locale);
      const user = userEvent.setup();

      await user.upload(
        screen.getByLabelText(attachInput),
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'lab.png', {
          type: 'image/png',
        }),
      );
      await user.click(screen.getByRole('textbox', { name: editor }));
      await user.keyboard(`${question}{Enter}`);

      expect(await userBubbleText(question)).toBe(question);
    });

    it('a message of only an image shows the image and no text bubble', async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      await using _ = msw.intercept(...zukhruf());
      renderChat(`chat-image-only-${locale ?? 'en'}`, locale);
      const user = userEvent.setup();

      await user.upload(
        screen.getByLabelText(attachInput),
        new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'lab.png', {
          type: 'image/png',
        }),
      );
      await user.click(screen.getByRole('textbox', { name: editor }));
      await user.keyboard('{Enter}');
      await screen.findByText('The answer.');
      const message = (await screen.findByRole('list', { name: attachments }))
        .parentElement;

      expect({
        parts: Array.from(message?.children ?? [], (child) =>
          child.getAttribute('aria-label'),
        ),
        text: message?.textContent,
      }).toEqual({ parts: [attachments], text: '' });
    });

    it('a prefill written with uploads shows the words in its bubble and stores them as the persistedPrompt', async () => {
      using stack = new DisposableStack();
      stack.defer(cleanup);
      stack.defer(clearPrefill);
      const chatId = `chat-prefill-${locale ?? 'en'}`;
      await using interception = msw.intercept(...zukhruf());
      const receipt = await new ZukhrufChatTransport({
        api: sessions,
      }).uploadFile(
        chatId,
        new File(['lab'], 'lab.png', { type: 'image/png' }),
      );
      // What Meddit's ask box passes: react-input's submission.prompt, the model-facing text, and submission.persistedPrompt, the user's words.
      writePrefill({
        prompt: `[Image #1] ${question}`,
        persistedPrompt: question,
        targetChatId: chatId,
        uploads: [receipt],
      });
      renderChat(chatId, locale);

      const bubble = await userBubbleText(question);
      const [message] = await postedMessages(interception.requests);

      expect({
        bubble,
        persistedPrompt: message?.metadata?.persistedPrompt,
      }).toEqual({ bubble: question, persistedPrompt: question });
    });
  },
);

describe('a user bubble shows what the user typed (#6316)', () => {
  it('a slash command shows the command and its words, not the prompt it expands to', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using _ = msw.intercept(...zukhruf());
    renderChat(
      'chat-slash-command',
      undefined,
      <Composer.Trigger trigger="/">
        <Composer.Command
          id="cmd-prompts-recent"
          value="prompts:recent"
          label="Recent"
          detail="List recent chats"
          supportsArgs
          expandsTo="List the latest conversations."
        />
      </Composer.Trigger>,
    );
    const user = userEvent.setup();

    await user.click(
      screen.getByRole('textbox', { name: 'Rich prompt composer' }),
    );
    await user.keyboard('/prompts:recent from today{Enter}');

    expect(await userBubbleText('from today')).toBe(
      '/prompts:recent from today',
    );
  });

  it('a collapsed paste shows in the words of an Arabic host, not [Pasted Content N chars]', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    await using interception = msw.intercept(...zukhruf());
    renderChat('chat-paste-ar', 'ar');
    const user = userEvent.setup();
    const prompt = screen.getByRole('textbox', { name: ar['composer.editor'] });
    const pasted = 'س'.repeat(1001);

    await user.click(prompt);
    await user.keyboard('لخّص ');
    fireEvent.paste(prompt, {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === 'text/plain' || type === 'text' ? pasted : '',
      },
    });
    await user.keyboard('{Enter}');
    const bubble = await userBubbleText('لخّص');
    const [message] = await postedMessages(interception.requests);

    expect({
      bubble,
      model: message?.parts,
    }).toEqual({
      bubble: 'لخّص [نص ملصق · 1,001 حرف]',
      model: [{ type: 'text', text: `لخّص ${pasted}` }],
    });
  });
});
