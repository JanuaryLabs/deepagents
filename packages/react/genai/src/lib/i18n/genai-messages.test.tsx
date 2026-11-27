import { createClock } from '@sinonjs/fake-timers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDirection } from '@zukhruf/shadcn';
import { ClockProvider } from '@zukhruf/ui';
import type { ChatStatus, UIMessage } from 'ai';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import { AgentProvider } from '../chat/agent-context.tsx';
import { AgentHeader } from '../chat/chat.tsx';
import {
  IndexProgress,
  type IndexProgressEvent,
} from '../chat/trajectory/IndexProgressSegment.tsx';
import { CompactMessages } from '../chat/trajectory/trajectories/compact-messages.tsx';
import { MessagesError } from '../chat/trajectory/trajectories/messages-error.tsx';
import { Messages } from '../chat/trajectory/trajectories/messages.tsx';
import { TimelinedMessages } from '../chat/trajectory/trajectories/timelined-messages.tsx';
import { ChatComposer } from '../components/ChatComposer.tsx';
import { SubmitButton } from '../components/SubmitButton.tsx';
import { MessageQueue } from '../components/queue.tsx';
import { ToolError } from '../components/tool-error.tsx';
import { AssistantSnapshot } from '../copy/assistant-snapshot.tsx';
import { Response } from '../elements/Response.tsx';
import type { ComponentRegistry } from '../tools/registry.ts';
import {
  type GenaiMessages,
  GenaiMessagesProvider,
  useGenaiMessages,
} from './index.ts';

const registry: ComponentRegistry = {
  runQuery: {
    static: true,
    component: () => null,
    label: () => ({ name: 'runQuery', args: { db: 'ds1' } }),
  },
  lookup: {
    static: true,
    component: () => null,
    label: () => ({ name: 'lookup', icon: Search }),
  },
};

const ar: GenaiMessages = {
  'citation.source': ({ index }, { format }) => `المصدر ${format(index)}`,
  'citation.open': 'افتح المصدر',
  'message.copy': 'انسخ الرسالة',
  'message.copied': 'نُسخت',
  'message.regenerate': 'أعد إنشاء الرد',
  'message.copyDebugJson': 'انسخ JSON التصحيح',
  'steps.working': 'جارٍ العمل…',
  'steps.reasoning': ({ detail }) => (detail ? `يفكّر ${detail}` : 'يفكّر'),
  'steps.reasoned': ({ detail }) => (detail ? `فكّر ${detail}` : 'فكّر'),
  'steps.call': ({ call, status }) =>
    ({
      complete: `استدعى ${call}`,
      error: `فشل ${call}`,
      aborted: `أُلغي ${call}`,
    })[status],
  'steps.tools': ({ count, status }, { plural }) =>
    `${plural(count, {
      zero: 'لم تعمل أي أداة',
      one: 'عملت أداة واحدة',
      two: 'عملت أداتان',
      few: 'عملت # أدوات',
      many: 'عملت # أداة',
      other: 'عملت # أداة',
    })}${status === 'complete' ? '' : status === 'error' ? ' مع مشكلات' : ' ثم أُلغيت'}`,
  'steps.unnamedTool': 'أداة',
  'steps.unknownStep': 'خطوة',
  'steps.thinking': 'يفكّر…',
  'steps.cancelledByUser': 'ألغاه المستخدم',
  'chat.greeting': 'كيف أساعدك اليوم؟',
  'chat.retry': 'حاول مجددًا',
  'chat.scrollToBottom': 'انتقل إلى آخر رسالة',
  'status.loading': 'جارٍ التحميل',
  'composer.attachFiles': 'أرفق ملفات',
  'composer.commandMenu': 'بدّل قائمة الأوامر',
  'composer.send': 'أرسل الطلب',
  'composer.stop': 'أوقف البث',
  'dictation.start': 'ابدأ الإملاء',
  'dictation.starting': 'يبدأ الإملاء',
  'dictation.stop': 'أوقف الإملاء',
  'dictation.transcribing': 'يجري التفريغ…',
  'dictation.cancel': 'ألغِ الإملاء',
  'dictation.cancelTranscription': 'ألغِ التفريغ',
  'dictation.unsupported': 'الإملاء غير متاح في هذا المتصفح',
  'dictation.blocked':
    'اسمح بالوصول إلى الميكروفون في إعدادات المتصفح لاستخدام الإملاء',
  'dictation.permissionDenied': 'اسمح بالوصول إلى الميكروفون لاستخدام الإملاء',
  'dictation.noMicrophone': 'وصّل ميكروفونًا لاستخدام الإملاء',
  'dictation.microphoneInUse': 'أغلق التطبيقات الأخرى التي تستخدم الميكروفون',
  'dictation.interrupted': 'انقطع التسجيل',
  'dictation.transcriptionFailed': 'تعذّر تفريغ الصوت',
  'queue.remove': 'احذف الرسالة المنتظرة',
  'message.attachments': 'الملفات المرفقة',
  'message.reminders': ({ count }, { plural }) =>
    plural(count, {
      zero: 'لا تذكيرات مرفقة',
      one: 'تذكير واحد مرفق',
      two: 'تذكيران مرفقان',
      few: '# تذكيرات مرفقة',
      many: '# تذكيرًا مرفقًا',
      other: '# تذكير مرفق',
    }),
  'message.usage': ({ input, output, total }) =>
    `↑ ${input} ↓ ${output}${total ? ` · ${total} رمز` : ''}`,
  'attachment.image': 'صورة مرفقة',
  'attachment.untitled': 'بلا عنوان',
  'attachment.file': 'ملف:',
  'attachment.download': 'نزّل',
  'approval.request': ({ tool }) => `موافقة ${tool}`,
  'approval.approve': 'وافق',
  'approval.deny': 'ارفض',
  'snapshot.copy': 'انسخ لقطة',
  'snapshot.copying': 'يجري نسخ اللقطة',
  'snapshot.copiedImage': 'نُسخت اللقطة',
  'snapshot.copiedText': 'نُسخ النص',
  'snapshot.clipboardUnavailable': 'الحافظة غير متاحة هنا.',
  'snapshot.imageUnsupported': 'نسخ الصور غير مدعوم في هذا المتصفح.',
  'snapshot.copyFailed': 'فشل النسخ. حاول مجددًا.',
  'response.renderFailed': ({ error }) => `تعذّر عرض المحتوى: ${error}`,
  'tool.executing': ({ tool }) => `ينفّذ ${tool}`,
  'tool.state': ({ state }) =>
    ({
      'input-streaming': 'معلّقة',
      'input-available': 'تعمل',
      'approval-requested': 'تنتظر الموافقة',
      'approval-responded': 'أُجيبت',
      'output-available': 'اكتملت',
      'output-error': 'خطأ',
      'output-denied': 'مرفوضة',
    })[state],
  'tool.parameters': 'المعاملات',
  'tool.result': 'النتيجة',
  'tool.error': 'خطأ',
  'tool.renderFailed': 'تعذّر عرض الأداة',
  'tool.details': 'اعرض التفاصيل',
  'tool.askToFix': 'اطلب من الذكاء الاصطناعي إصلاحه',
  'indexing.running': 'يفهرس',
  'indexing.done': 'فُهرس المخطط',
  'indexing.failed': 'فشل',
  'indexing.adapters': ({ count }, { plural }) =>
    plural(count, {
      one: 'محوّل واحد',
      two: 'محوّلان',
      few: '# محوّلات',
      many: '# محوّلًا',
      other: '# محوّل',
    }),
  'indexing.cacheHit': 'من الذاكرة المؤقتة',
  'indexing.refreshed': 'حُدّث',
  'indexing.queued': 'في الانتظار',
  markdown: { copyTable: 'انسخ الجدول', downloadTable: 'نزّل الجدول' },
};

function Harness({ children }: { children: ReactNode }) {
  return (
    <ClockProvider clock={createClock()}>
      <AgentProvider
        chatId="genai-messages-test"
        debugMode={false}
        registry={registry}
        transport={new StoredMessagesTransport()}
        onResetChat={() => undefined}
      >
        {children}
      </AgentProvider>
    </ClockProvider>
  );
}

function runQuery(
  toolCallId: string,
  state: 'output-available' | 'input-available',
): UIMessage['parts'][number] {
  const input = { query: 'select 1', db: 'ds1' };
  return state === 'output-available'
    ? { type: 'tool-runQuery', toolCallId, state, input, output: 'ok' }
    : { type: 'tool-runQuery', toolCallId, state, input };
}

const answered: UIMessage = {
  id: 'asst-answered',
  role: 'assistant',
  parts: [
    runQuery('tc-1', 'output-available'),
    runQuery('tc-2', 'output-available'),
    {
      type: 'text',
      text: 'Apixaban needs no change in mild impairment.',
      citations: [
        {
          source: {
            type: 'source',
            sourceType: 'url',
            id: 'label',
            url: 'https://label.example/apixaban',
            title: 'Apixaban label',
          },
        },
      ],
    },
  ],
};

const working: UIMessage = {
  id: 'asst-working',
  role: 'assistant',
  parts: [runQuery('tc-3', 'input-available')],
};

function renderChat(
  messages: UIMessage[],
  status: ChatStatus,
  wrap: (chat: ReactNode) => ReactNode,
) {
  render(
    wrap(
      <CompactMessages.Root messages={messages} status={status}>
        {messages.map((message, index) => (
          <CompactMessages.Item
            key={message.id}
            message={message}
            index={index}
          >
            <CompactMessages.AssistantContent />
            <CompactMessages.Actions>
              <CompactMessages.CopyAction />
              <CompactMessages.RegenerateAction />
              <CompactMessages.CopyDebugJsonAction />
            </CompactMessages.Actions>
          </CompactMessages.Item>
        ))}
      </CompactMessages.Root>,
    ),
    { wrapper: Harness },
  );
}

function stubClipboard(stack: DisposableStack) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
  stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));
}

describe('GenaiMessagesProvider with an Arabic catalog', () => {
  it('translates the step line, the message actions and the citation in static mode', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    stubClipboard(stack);
    const user = userEvent.setup();

    renderChat([answered], 'ready', (chat) => (
      <GenaiMessagesProvider locale="ar" messages={ar}>
        {chat}
      </GenaiMessagesProvider>
    ));
    await user.click(screen.getByRole('button', { name: 'المصدر 1' }));
    const link = screen.getByRole('link', { name: 'افتح المصدر' });
    await user.click(screen.getByRole('button', { name: 'انسخ الرسالة' }));

    expect({
      steps: screen.getByText('عملت أداتان').tagName,
      link: link.getAttribute('href'),
      actions: screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
        .filter((label) => label !== null && label !== 'المصدر 1'),
    }).toEqual({
      steps: 'SPAN',
      link: 'https://label.example/apixaban',
      actions: ['نُسخت', 'أعد إنشاء الرد', 'انسخ JSON التصحيح'],
    });
  });

  it('translates the running step, the finished step line, the message actions and the citation in streaming mode', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const user = userEvent.setup();

    renderChat([answered, working], 'streaming', (chat) => (
      <GenaiMessagesProvider locale="ar" messages={ar}>
        {chat}
      </GenaiMessagesProvider>
    ));
    await user.click(screen.getByRole('button', { name: 'المصدر 1' }));

    expect({
      finished: screen.getByText('عملت أداتان').tagName,
      running: screen.getByText('جارٍ العمل…').tagName,
      link: screen
        .getByRole('link', { name: 'افتح المصدر' })
        .getAttribute('href'),
      actions: ['انسخ الرسالة', 'أعد إنشاء الرد', 'انسخ JSON التصحيح'].map(
        (name) => screen.getAllByRole('button', { name }).length,
      ),
    }).toEqual({
      finished: 'SPAN',
      running: 'SPAN',
      link: 'https://label.example/apixaban',
      actions: [1, 1, 1],
    });
  });

  it('picks the Arabic plural form of a tool count from Intl.PluralRules', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const counts = [0, 1, 2, 3, 11, 100];

    function Counts() {
      const t = useGenaiMessages();
      return counts.map((count) => (
        <p key={count}>{t('steps.tools', { count, status: 'complete' })}</p>
      ));
    }
    render(
      <GenaiMessagesProvider locale="ar" messages={ar}>
        <Counts />
      </GenaiMessagesProvider>,
    );

    expect(
      screen.getAllByRole('paragraph').map((line) => line.textContent),
    ).toEqual([
      'لم تعمل أي أداة',
      'عملت أداة واحدة',
      'عملت أداتان',
      'عملت 3 أدوات',
      'عملت 11 أداة',
      'عملت 100 أداة',
    ]);
  });
});

describe('GenaiMessagesProvider catalogs', () => {
  function actionNames() {
    return screen
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
      .filter((label) => label !== null && !label.startsWith('Source'));
  }

  it('keeps the English words for the keys a partial catalog lacks', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderChat([answered], 'ready', (chat) => (
      <GenaiMessagesProvider locale="ar" messages={{ 'message.copy': 'انسخ' }}>
        {chat}
      </GenaiMessagesProvider>
    ));

    expect({
      actions: actionNames(),
      steps: screen.getByText('Ran 2 tools').tagName,
    }).toEqual({
      actions: ['انسخ', 'Regenerate response', 'Copy debug JSON'],
      steps: 'SPAN',
    });
  });

  it('merges nested catalogs, the inner one winning', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderChat([answered], 'ready', (chat) => (
      <GenaiMessagesProvider
        locale="ar"
        messages={{
          'message.copy': 'outer copy',
          'message.regenerate': 'outer regenerate',
        }}
      >
        <GenaiMessagesProvider
          locale="ar"
          messages={{ 'message.copy': 'inner copy' }}
        >
          {chat}
        </GenaiMessagesProvider>
      </GenaiMessagesProvider>
    ));

    expect(actionNames()).toEqual([
      'inner copy',
      'outer regenerate',
      'Copy debug JSON',
    ]);
  });
});

describe('without a GenaiMessagesProvider', () => {
  it('keeps the English step lines a host saw before the catalog', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Lines() {
      const t = useGenaiMessages();
      return [
        t('steps.tools', { count: 1, status: 'complete' }),
        t('steps.tools', { count: 2, status: 'error' }),
        t('steps.tools', { count: 3, status: 'aborted' }),
        t('steps.call', { call: 'runQuery(db: ds1)', status: 'complete' }),
        t('steps.call', { call: 'runQuery(db: ds1)', status: 'error' }),
        t('steps.call', { call: 'runQuery(db: ds1)', status: 'aborted' }),
        t('steps.reasoning', { detail: 'about dosing' }),
        t('steps.reasoned', { detail: undefined }),
        t('steps.working'),
        t('citation.source', { index: 4 }),
      ].map((line) => <p key={line}>{line}</p>);
    }
    render(<Lines />);

    expect(
      screen.getAllByRole('paragraph').map((line) => line.textContent),
    ).toEqual([
      'Ran 1 tool',
      'Ran 2 tools with issues',
      'Cancelled after running 3 tools',
      'Called runQuery(db: ds1)',
      'Failed runQuery(db: ds1)',
      'Cancelled runQuery(db: ds1)',
      'Reasoning about dosing',
      'Reasoned',
      'Working...',
      'Source 4',
    ]);
  });
});

function inArabic(chat: ReactNode) {
  return (
    <GenaiMessagesProvider locale="ar" messages={ar}>
      {chat}
    </GenaiMessagesProvider>
  );
}

const asked: UIMessage = {
  id: 'user-asked',
  role: 'user',
  parts: [{ type: 'text', text: '[Image #1] what is this?' }],
  metadata: {
    uploads: [
      {
        path: '/workspace/.uploads/s1/shot.png',
        name: 'shot.png',
        mediaType: 'image/png',
        size: 4,
        url: 'https://uploads.test/shot.png',
      },
    ],
    reminders: [
      { id: 'r1', text: 'Answer briefly' },
      { id: 'r2', text: 'Cite the label' },
    ],
    usage: { inputTokens: 1200, outputTokens: 30, totalTokens: 1230 },
  },
};

const delivered: UIMessage = {
  id: 'asst-delivered',
  role: 'assistant',
  parts: [
    { type: 'file', mediaType: 'application/pdf', url: 'https://files.test/r' },
    { type: 'file', mediaType: 'image/png', url: 'https://files.test/c.png' },
    {
      type: 'tool-runQuery',
      toolCallId: 'tc-approval',
      state: 'approval-requested',
      input: { query: 'select 1', db: 'ds1' },
      approval: { id: 'ap-1' },
    },
  ],
};

const tableAnswer =
  '| Region | Revenue |\n| --- | --- |\n| EMEA | 120 |\n| APAC | 90 |\n';

function tableButtons(container: HTMLElement) {
  return [
    ...container.querySelectorAll(
      '[data-slot="table-panel-header"] button[title]',
    ),
  ].map((button) => button.getAttribute('title'));
}

describe('GenaiMessagesProvider with an Arabic catalog across the chat', () => {
  it('translates the composer, its dictation button, the send and stop buttons and the queue', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      inArabic(
        <>
          <ChatComposer.Provider
            dictation={{ transcribe: () => Promise.resolve({ text: '' }) }}
          >
            <ChatComposer.Root>
              <ChatComposer.Content>
                <ChatComposer.Editor />
              </ChatComposer.Content>
              <ChatComposer.Toolbar>
                <ChatComposer.AttachFiles />
                <ChatComposer.CommandButton />
                <ChatComposer.Dictate />
              </ChatComposer.Toolbar>
            </ChatComposer.Root>
          </ChatComposer.Provider>
          <SubmitButton variant="send" />
          <SubmitButton variant="stop" />
          <MessageQueue.Remove onClick={() => undefined} />
        </>,
      ),
      { wrapper: Harness },
    );

    expect(
      [
        'أرفق ملفات',
        'بدّل قائمة الأوامر',
        'الإملاء غير متاح في هذا المتصفح',
        'أرسل الطلب',
        'أوقف البث',
        'احذف الرسالة المنتظرة',
      ].map((name) => screen.queryAllByRole('button', { name }).length),
    ).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('translates the greeting, the attachments, the reminders, the usage, the approval and the retry in static mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const messages = [asked, delivered];

    render(
      inArabic(
        <>
          <AgentHeader.Hero />
          <Messages.Root messages={messages} status="ready">
            {messages.map((message, index) => (
              <Messages.Item key={message.id} message={message} index={index}>
                {message.role === 'user' ? (
                  <Messages.UserBubble />
                ) : (
                  <Messages.AssistantContent />
                )}
              </Messages.Item>
            ))}
          </Messages.Root>
          <MessagesError error={new Error('boom')} onRetry={() => undefined} />
        </>,
      ),
      { wrapper: Harness },
    );
    const approval = screen.getByRole('group', { name: 'موافقة runQuery' });

    expect({
      greeting: screen.getByRole('heading').textContent,
      attachments: screen.getAllByRole('list', { name: 'الملفات المرفقة' })
        .length,
      reminders: screen.getAllByRole('button', { name: 'تذكيران مرفقان' })
        .length,
      usage: screen.getByText('↑ 1.2K ↓ 30 · 1,230 رمز').tagName,
      file: screen.getByText('ملف:').tagName,
      untitled: screen.getByText(/بلا عنوان/).tagName,
      download: screen.getByRole('link', { name: 'نزّل' }).getAttribute('href'),
      image: screen
        .getByRole('img', { name: 'صورة مرفقة' })
        .getAttribute('src'),
      approval: within(approval)
        .getAllByRole('button')
        .map((button) => button.textContent),
      retry: screen.getAllByRole('button', { name: 'حاول مجددًا' }).length,
    }).toEqual({
      greeting: 'كيف أساعدك اليوم؟',
      attachments: 1,
      reminders: 1,
      usage: 'DIV',
      file: 'STRONG',
      untitled: 'DIV',
      download: 'https://files.test/r',
      image: 'https://files.test/c.png',
      approval: ['ارفض', 'وافق'],
      retry: 1,
    });
  });

  it('translates the reasoning step and a step the user cancelled in the timeline in static mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const message: UIMessage = {
      id: 'asst-cancelled',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'dosing' },
        runQuery('tc-cancelled', 'input-available'),
      ],
    };

    const { container } = render(
      inArabic(
        <QueryClientProvider client={new QueryClient()}>
          <TimelinedMessages.Root messages={[message]} status="ready">
            <TimelinedMessages.Item message={message} index={0}>
              <TimelinedMessages.AssistantContent />
            </TimelinedMessages.Item>
          </TimelinedMessages.Root>
        </QueryClientProvider>,
      ),
      { wrapper: Harness },
    );

    expect({
      reasoning: container.textContent.includes('يفكّر'),
      english: /Reasoning|Cancelled/.test(container.textContent),
      cancelled: screen.getAllByText('ألغاه المستخدم').length,
    }).toEqual({ reasoning: true, english: false, cancelled: 1 });
  });

  it('translates the thinking line and the running step spinner in streaming mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const lookingUp: UIMessage = {
      id: 'asst-looking-up',
      role: 'assistant',
      parts: [
        {
          type: 'tool-lookup',
          toolCallId: 'tc-lookup',
          state: 'input-available',
          input: { term: 'apixaban' },
        },
      ],
    };
    const question: UIMessage = {
      id: 'user-question',
      role: 'user',
      parts: [{ type: 'text', text: 'dose?' }],
    };

    render(
      inArabic(
        <>
          <Messages.Root messages={[question]} status="streaming">
            <Messages.Thinking />
          </Messages.Root>
          <TimelinedMessages.Root messages={[lookingUp]} status="streaming">
            <TimelinedMessages.Item message={lookingUp} index={0}>
              <TimelinedMessages.AssistantContent />
            </TimelinedMessages.Item>
          </TimelinedMessages.Root>
        </>,
      ),
      { wrapper: Harness },
    );

    expect(
      screen.getAllByRole('status').map((status) => ({
        label: status.getAttribute('aria-label'),
        text: status.textContent,
      }))[0],
    ).toEqual({ label: null, text: 'يفكّر…' });
    expect(screen.getAllByRole('status', { name: 'جارٍ التحميل' }).length).toBe(
      1,
    );
  });

  it('translates the debug view of a tool call', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const user = userEvent.setup();
    const message: UIMessage = {
      id: 'asst-debug',
      role: 'assistant',
      parts: [runQuery('tc-debug', 'output-available')],
    };

    render(
      inArabic(
        <ClockProvider clock={createClock()}>
          <AgentProvider
            chatId="genai-messages-debug"
            debugMode
            registry={registry}
            transport={new StoredMessagesTransport()}
            onResetChat={() => undefined}
          >
            <Messages.Root messages={[message]} status="ready">
              <Messages.Item message={message} index={0}>
                <Messages.AssistantContent />
              </Messages.Item>
            </Messages.Root>
          </AgentProvider>
        </ClockProvider>,
      ),
    );
    await user.click(screen.getByRole('button', { name: /ينفّذ runQuery/ }));

    expect({
      header: screen.getByRole('button', { name: /ينفّذ runQuery/ })
        .textContent,
      headings: screen
        .getAllByRole('heading', { level: 4 })
        .map((heading) => heading.textContent),
    }).toEqual({
      header: 'ينفّذ runQueryاكتملت',
      headings: ['المعاملات', 'النتيجة'],
    });
  });

  it('translates the card of a tool whose input failed to parse', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const parsed = z.object({ db: z.string() }).safeParse({ db: 1 });
    if (parsed.success) throw new Error('The fixture must fail to parse.');

    const { container } = render(
      inArabic(
        <ToolError
          part={{
            type: 'tool-runQuery',
            toolCallId: 'tc-bad',
            state: 'input-available',
            input: { db: 1 },
          }}
          error={parsed.error}
          detail="db must be a string"
        />,
      ),
      { wrapper: Harness },
    );

    expect({
      english: /Failed|Error|View details|Ask AI/.test(container.textContent),
      title: screen.getAllByText('تعذّر عرض الأداة').length,
      alert: screen.getAllByText('خطأ').length,
      details: screen.getAllByText('اعرض التفاصيل').length,
      fix: screen.getAllByRole('button', {
        name: 'اطلب من الذكاء الاصطناعي إصلاحه',
      }).length,
    }).toEqual({ english: false, title: 1, alert: 1, details: 1, fix: 1 });
  });

  it('translates the schema indexing breadcrumbs, the adapter count through plural forms', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const runs: IndexProgressEvent[][] = [
      [
        { type: 'index:start', total: 1, message: '' },
        { type: 'adapter:start', adapter: 'pg', message: '' },
      ],
      [
        { type: 'index:start', total: 3, message: '' },
        { type: 'adapter:start', adapter: 'pg', message: '' },
        { type: 'adapter:start', adapter: 'mssql', message: '' },
        { type: 'adapter:start', adapter: 'sqlite', message: '' },
        { type: 'index:end', message: '' },
      ],
      [{ type: 'index:error', message: 'connection refused' }],
    ];

    render(
      inArabic(
        runs.map((events) => (
          <IndexProgress.Root key={events.at(-1)?.type} events={events}>
            <IndexProgress.Trigger />
          </IndexProgress.Root>
        )),
      ),
    );

    expect(
      screen.getAllByRole('button').map((button) => button.textContent),
    ).toEqual([
      expect.stringMatching(/^يفهرس/),
      expect.stringMatching(/^فُهرس المخطط.*3 محوّلات$/),
      expect.stringMatching(/^فشل.*connection refused$/),
    ]);
  });

  it('translates the snapshot copy button, its copied label and its failure', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    // userEvent.setup() gives the page a clipboard that takes text.
    const user = userEvent.setup();

    render(
      inArabic(
        <ClockProvider clock={createClock()}>
          <AssistantSnapshot
            message={answered}
            renderContent={() => 'Apixaban'}
          />
        </ClockProvider>,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'انسخ لقطة' }));
    const copied = await screen.findByRole('button', { name: 'نُسخ النص' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));
    await user.click(copied);

    expect((await screen.findByText('الحافظة غير متاحة هنا.')).tagName).toBe(
      'SPAN',
    );
  });

  it('hands the markdown slice to streamdown in static and streaming mode, and a Response prop wins', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      inArabic(
        <>
          <div data-testid="static">
            <Response mode="static">{tableAnswer}</Response>
          </div>
          <div data-testid="streaming">
            <Response>{tableAnswer}</Response>
          </div>
          <div data-testid="host">
            <Response translations={{ copyTable: 'host copy' }}>
              {tableAnswer}
            </Response>
          </div>
        </>,
      ),
    );

    expect(
      ['static', 'streaming', 'host'].map((id) =>
        tableButtons(screen.getByTestId(id)),
      ),
    ).toEqual([
      ['انسخ الجدول', 'نزّل الجدول'],
      ['انسخ الجدول', 'نزّل الجدول'],
      ['host copy', 'نزّل الجدول'],
    ]);
  });
});

describe('GenaiMessagesProvider catalogs beyond the step lines', () => {
  it('keeps the English composer and markdown words a partial catalog lacks', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const { container } = render(
      <GenaiMessagesProvider
        locale="ar"
        messages={{
          'composer.send': 'أرسل',
          markdown: { copyTable: 'انسخ الجدول' },
        }}
      >
        <SubmitButton variant="send" />
        <SubmitButton variant="stop" />
        <Response mode="static">{tableAnswer}</Response>
      </GenaiMessagesProvider>,
    );

    expect({
      buttons: screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
        .filter((label) => label !== null),
      table: tableButtons(container),
    }).toEqual({
      buttons: ['أرسل', 'Stop streaming'],
      table: ['انسخ الجدول', 'Download table'],
    });
  });

  it('merges the markdown slices of nested providers, the inner one winning', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const { container } = render(
      <GenaiMessagesProvider
        locale="ar"
        messages={{
          markdown: {
            copyTable: 'outer copy',
            downloadTable: 'outer download',
          },
        }}
      >
        <GenaiMessagesProvider
          locale="ar"
          messages={{ markdown: { downloadTable: 'inner download' } }}
        >
          <Response mode="static">{tableAnswer}</Response>
        </GenaiMessagesProvider>
      </GenaiMessagesProvider>,
    );

    expect(tableButtons(container)).toEqual(['outer copy', 'inner download']);
  });

  it("gives Base UI the locale's direction unless dir is given", () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Direction() {
      return <p>{useDirection()}</p>;
    }
    render(
      <>
        <GenaiMessagesProvider locale="ar">
          <Direction />
        </GenaiMessagesProvider>
        <GenaiMessagesProvider locale="ar" dir="ltr">
          <Direction />
        </GenaiMessagesProvider>
        <GenaiMessagesProvider locale="en">
          <Direction />
        </GenaiMessagesProvider>
      </>,
    );

    expect(
      screen.getAllByRole('paragraph').map((line) => line.textContent),
    ).toEqual(['rtl', 'ltr', 'ltr']);
  });
});

describe('without a GenaiMessagesProvider, beyond the step lines', () => {
  it('keeps the English words a host saw before the catalog', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Lines() {
      const t = useGenaiMessages();
      return [
        t('message.reminders', { count: 1 }),
        t('message.reminders', { count: 2 }),
        t('message.usage', {
          input: '1.2M',
          output: '34.6K',
          total: '1,234,567',
          cached: '900',
        }),
        t('message.usage', {
          input: '1',
          output: '2',
          total: undefined,
          cached: undefined,
        }),
        t('indexing.adapters', { count: 3 }),
        t('tool.state', { state: 'approval-requested' }),
        t('tool.executing', { tool: 'runQuery' }),
        t('approval.request', { tool: 'runQuery' }),
        t('response.renderFailed', { error: 'boom' }),
        t('dictation.transcribing'),
        t('snapshot.copy'),
      ].map((line) => <p key={line}>{line}</p>);
    }
    render(<Lines />);

    expect(
      screen.getAllByRole('paragraph').map((line) => line.textContent),
    ).toEqual([
      '1 reminder attached',
      '2 reminders attached',
      '↑ 1.2M ↓ 34.6K · 1,234,567 tokens (900 cached)',
      '↑ 1 ↓ 2',
      '3 adapters',
      'Awaiting Approval',
      'Executing runQuery',
      'runQuery approval',
      'Failed to render content: boom',
      'Transcribing…',
      'Copy snapshot',
    ]);
  });
});
