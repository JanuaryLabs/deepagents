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

import { Composer } from '@deepagents/react-input/browser';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import { AgentProvider } from '../chat/agent-context.tsx';
import { AgentHeader } from '../chat/chat.tsx';
import {
  IndexProgress,
  type IndexProgressEvent,
} from '../chat/trajectory/IndexProgressSegment.tsx';
import { CompactMessages } from '../chat/trajectory/trajectories/compact-messages.tsx';
import { MessagesError } from '../chat/trajectory/trajectories/messages-error.tsx';
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
  'chat.error': 'حدث خطأ. حاول مجددًا.',
  'chat.errorRateLimited': 'طلبات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
  'chat.scrollToBottom': 'انتقل إلى آخر رسالة',
  'chat.messagesRegion': 'الرسائل',
  'composer.attachFiles': 'أرفق ملفات',
  'composer.commandMenu': 'بدّل قائمة الأوامر',
  'composer.send': 'أرسل الطلب',
  'composer.stop': 'أوقف البث',
  'composer.editor': 'اكتب رسالتك',
  'composer.placeholder': 'اكتب رسالة أو / للأوامر',
  'composer.sendFailed': 'تعذّر إرسال الطلب',
  'composer.uploadTooLarge': 'الملف أكبر من أن يُرفع.',
  'composer.uploadUnsupported': 'لا يمكن رفع هذا النوع من الملفات.',
  'composer.uploadFailed': 'تعذّر رفع الملف. حاول مجددًا.',
  'composer.attachments': 'الملفات المرفقة بالطلب',
  'composer.attachment': ({ media, number }, { format }) =>
    `${{ image: 'الصورة', video: 'الفيديو', audio: 'المقطع الصوتي' }[media]} ${format(number)}`,
  'composer.removeAttachment': ({ label }) => `أزل ${label}`,
  'composer.attachInput': 'أرفق ملفات وسائط',
  'composer.suggestions': 'الاقتراحات',
  'composer.noMatches': 'لا نتائج',
  'composer.takesArgs': 'معاملات',
  'composer.unsupportedFile': ({ name }) =>
    name === undefined
      ? 'يمكن إرفاق ملفات الصور والفيديو والصوت فقط، وهذا الملف بلا اسم'
      : `يمكن إرفاق ملفات الصور والفيديو والصوت فقط: ${name}`,
  'composer.unknownCommand': ({ name }) => `أمر غير معروف: /${name}`,
  'composer.attachmentMissing': ({ placeholder }) =>
    `الملف المرفق لم يعد متاحًا: ${placeholder}`,
  'composer.promptTooLong': ({ chars, maxChars }, { plural }) => {
    const forms = {
      zero: 'لا أحرف',
      one: 'حرف واحد',
      two: 'حرفان',
      few: '# أحرف',
      many: '# حرفًا',
      other: '# حرف',
    };
    return `الطلب أطول من الحد بعد توسيع المحتوى الملصق (${plural(chars, forms)}، والحد ${plural(maxChars, forms)}).`;
  },
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
  it('translates the composer, its editor, attachments, suggestions and send failure, its dictation button, the send and stop buttons and the queue', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const user = userEvent.setup();
    render(
      inArabic(
        <>
          <ChatComposer.Provider
            dictation={{ transcribe: () => Promise.resolve({ text: '' }) }}
            onSubmit={() => Promise.reject('offline')}
          >
            <Composer.Trigger trigger="/">
              <Composer.Command
                id="cmd-review"
                value="review"
                label="Review"
                detail="Review the prompt"
                supportsArgs
              />
            </Composer.Trigger>
            <Composer.Trigger trigger="@">
              <Composer.Mention
                id="file-readme"
                value="README.md"
                label="README.md"
                detail="file"
              />
            </Composer.Trigger>
            <ChatComposer.Root>
              <ChatComposer.Popup />
              <ChatComposer.Content>
                <ChatComposer.Attachments />
                <ChatComposer.Editor />
                <ChatComposer.Error />
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

    const prompt = await screen.findByRole('textbox', {
      name: ar['composer.editor'],
    });
    await user.upload(
      screen.getByLabelText(ar['composer.attachInput']),
      new File(['png'], 'chart.png', { type: 'image/png' }),
    );
    await screen.findByRole('list', { name: ar['composer.attachments'] });
    await user.click(prompt);
    await user.keyboard('hello /rev');
    const suggestion = within(
      screen.getByRole('listbox', { name: ar['composer.suggestions'] }),
    ).getByRole('option').textContent;
    await user.keyboard(' @zzz');
    await screen.findByText(ar['composer.noMatches']);
    const empty = screen.getByRole('listbox', {
      name: ar['composer.suggestions'],
    }).textContent;
    await user.keyboard('{Escape}{Enter}');

    expect({
      placeholder: prompt.getAttribute('aria-placeholder'),
      remove: screen.queryAllByRole('button', { name: 'أزل الصورة 1' }).length,
      preview: screen.queryAllByRole('img', { name: 'الصورة 1' }).length,
      suggestion,
      empty,
      failure: (await screen.findByRole('alert')).textContent,
    }).toEqual({
      placeholder: ar['composer.placeholder'],
      remove: 1,
      preview: 1,
      suggestion: '/reviewمعاملاتReview the prompt',
      empty: ar['composer.noMatches'],
      failure: ar['composer.sendFailed'],
    });
  });

  it('translates why the composer refused a file, with its name and without one, and an unknown command', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const user = userEvent.setup({ applyAccept: false });
    render(
      inArabic(
        <ChatComposer.Provider onSubmit={() => Promise.resolve()}>
          <Composer.Trigger trigger="/">
            <Composer.Command
              id="cmd-review"
              value="review"
              label="Review"
              detail="Review the change"
            />
          </Composer.Trigger>
          <ChatComposer.Root>
            <ChatComposer.Content>
              <ChatComposer.Editor />
              <ChatComposer.Error />
            </ChatComposer.Content>
            <ChatComposer.Toolbar>
              <ChatComposer.AttachFiles />
            </ChatComposer.Toolbar>
          </ChatComposer.Root>
        </ChatComposer.Provider>,
      ),
      { wrapper: Harness },
    );
    const prompt = await screen.findByRole('textbox', {
      name: ar['composer.editor'],
    });
    const input = screen.getByLabelText(ar['composer.attachInput']);

    await user.upload(
      input,
      new File(['a,b'], 'report.csv', { type: 'text/csv' }),
    );
    const named = (await screen.findByRole('alert')).textContent;
    await user.upload(input, new File(['a,b'], '', { type: 'text/csv' }));
    const unnamed = screen.getByRole('alert').textContent;
    await user.click(prompt);
    await user.keyboard('/nope now{Enter}');

    expect({
      named,
      unnamed,
      command: screen.getByRole('alert').textContent,
    }).toEqual({
      named: 'يمكن إرفاق ملفات الصور والفيديو والصوت فقط: report.csv',
      unnamed: 'يمكن إرفاق ملفات الصور والفيديو والصوت فقط، وهذا الملف بلا اسم',
      command: 'أمر غير معروف: /nope',
    });
  });

  it('translates why the composer refused an attachment brought back by undo, and draws an X in its remove button', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const user = userEvent.setup();
    render(
      inArabic(
        <ChatComposer.Provider onSubmit={() => Promise.resolve()}>
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
        </ChatComposer.Provider>,
      ),
      { wrapper: Harness },
    );
    const prompt = await screen.findByRole('textbox', {
      name: ar['composer.editor'],
    });

    await user.upload(
      screen.getByLabelText(ar['composer.attachInput']),
      new File(['png'], 'chart.png', { type: 'image/png' }),
    );
    const remove = await screen.findByRole('button', {
      name: 'أزل الصورة 1',
    });
    const icons = Array.from(remove.querySelectorAll('svg'), (icon) =>
      icon.getAttribute('class'),
    );
    // ProseMirror groups edits less than 500 ms apart into one undo step.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await user.click(remove);
    await user.click(prompt);
    await user.keyboard('{Control>}z{/Control}{Enter}');

    expect({
      icons,
      failure: (await screen.findByRole('alert')).textContent,
    }).toEqual({
      icons: ['lucide lucide-x size-3'],
      failure: 'الملف المرفق لم يعد متاحًا: [Image #1]',
    });
  });

  it('translates why the composer refused an over-long prompt, with Arabic plural forms of both counts', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Counts() {
      const t = useGenaiMessages();
      return [
        { chars: 2, maxChars: 1 },
        { chars: 11, maxChars: 3 },
        { chars: 100, maxChars: 2 },
      ].map((counts) => (
        <li key={counts.chars}>{t('composer.promptTooLong', counts)}</li>
      ));
    }
    const user = userEvent.setup();
    render(
      inArabic(
        <>
          <ChatComposer.Provider
            maxExpandedTextChars={5}
            onSubmit={() => Promise.resolve()}
          >
            <ChatComposer.Root>
              <ChatComposer.Content>
                <ChatComposer.Editor />
                <ChatComposer.Error />
              </ChatComposer.Content>
            </ChatComposer.Root>
          </ChatComposer.Provider>
          <ul aria-label="plurals">
            <Counts />
          </ul>
        </>,
      ),
      { wrapper: Harness },
    );
    const prompt = await screen.findByRole('textbox', {
      name: ar['composer.editor'],
    });

    await user.click(prompt);
    await user.keyboard('hello world{Enter}');

    expect({
      failure: (await screen.findByRole('alert')).textContent,
      plurals: within(screen.getByRole('list', { name: 'plurals' }))
        .getAllByRole('listitem')
        .map((line) => line.textContent),
    }).toEqual({
      failure:
        'الطلب أطول من الحد بعد توسيع المحتوى الملصق (11 حرفًا، والحد 5 أحرف).',
      plurals: [
        'الطلب أطول من الحد بعد توسيع المحتوى الملصق (حرفان، والحد حرف واحد).',
        'الطلب أطول من الحد بعد توسيع المحتوى الملصق (11 حرفًا، والحد 3 أحرف).',
        'الطلب أطول من الحد بعد توسيع المحتوى الملصق (100 حرف، والحد حرفان).',
      ],
    });
  });

  it('translates the greeting, the attachments, the reminders, the usage, the approval and the retry in static mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const messages = [asked, delivered];

    render(
      inArabic(
        <>
          <AgentHeader.Hero />
          <CompactMessages.Root messages={messages} status="ready">
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
          </CompactMessages.Root>
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
      error: screen.getByRole('alert').textContent,
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
      error: 'حدث خطأ. حاول مجددًا.',
    });
  });

  it('translates a step the user cancelled in static mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const message: UIMessage = {
      id: 'asst-cancelled',
      role: 'assistant',
      parts: [runQuery('tc-cancelled', 'input-available')],
    };

    const { container } = render(
      inArabic(
        <CompactMessages.Root messages={[message]} status="ready">
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.Root>,
      ),
      { wrapper: Harness },
    );

    expect({
      english: /Cancelled/.test(container.textContent),
      cancelled: screen.getAllByText('ألغاه المستخدم').length,
    }).toEqual({ english: false, cancelled: 1 });
  });

  it('translates the running reasoning step in streaming mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const message: UIMessage = {
      id: 'asst-reasoning',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: '\n\n' }],
    };

    const { container } = render(
      inArabic(
        <ClockProvider clock={createClock()}>
          <AgentProvider
            chatId="genai-messages-reasoning"
            debugMode
            registry={registry}
            transport={new StoredMessagesTransport()}
            onResetChat={() => undefined}
          >
            <QueryClientProvider client={new QueryClient()}>
              <CompactMessages.Root messages={[message]} status="streaming">
                <CompactMessages.Item message={message} index={0}>
                  <CompactMessages.AssistantContent />
                </CompactMessages.Item>
              </CompactMessages.Root>
            </QueryClientProvider>
          </AgentProvider>
        </ClockProvider>,
      ),
    );

    expect({
      title: screen.getByText('يفكّر').tagName,
      english: /Reasoning|Thinking/.test(container.textContent),
    }).toEqual({ title: 'SPAN', english: false });
  });

  it('translates the thinking line in streaming mode', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const question: UIMessage = {
      id: 'user-question',
      role: 'user',
      parts: [{ type: 'text', text: 'dose?' }],
    };

    render(
      inArabic(
        <CompactMessages.Root messages={[question]} status="streaming">
          <CompactMessages.Thinking />
        </CompactMessages.Root>,
      ),
      { wrapper: Harness },
    );

    expect(
      screen.getAllByRole('status').map((status) => ({
        label: status.getAttribute('aria-label'),
        text: status.textContent,
      })),
    ).toEqual([{ label: null, text: 'يفكّر…' }]);
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
            <CompactMessages.Root messages={[message]} status="ready">
              <CompactMessages.Item message={message} index={0}>
                <CompactMessages.AssistantContent />
              </CompactMessages.Item>
            </CompactMessages.Root>
          </AgentProvider>
        </ClockProvider>,
      ),
    );
    await user.click(screen.getByRole('button', { name: /^runQuery\(/ }));
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
        t('composer.uploadTooLarge'),
        t('composer.uploadUnsupported'),
        t('composer.uploadFailed'),
        t('composer.attachment', { media: 'image', number: 1 }),
        t('composer.attachment', { media: 'video', number: 2 }),
        t('composer.attachment', { media: 'audio', number: 3 }),
        t('composer.removeAttachment', { label: '[Image #1]' }),
        t('composer.unsupportedFile', { name: 'report.csv' }),
        t('composer.unsupportedFile', { name: undefined }),
        t('composer.unknownCommand', { name: 'nope' }),
        t('composer.attachmentMissing', { placeholder: '[Image #1]' }),
        t('composer.promptTooLong', { chars: 25, maxChars: 12 }),
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
      'The file is too large to upload.',
      'This type of file cannot be uploaded.',
      'Could not upload the file. Try again.',
      '[Image #1]',
      '[Video #2]',
      '[Audio #3]',
      'Remove [Image #1]',
      'Only image, video, or audio files can be attached: report.csv',
      'Only image, video, or audio files can be attached: unnamed file',
      'Unrecognized command: /nope',
      'Attached image is no longer available: [Image #1]',
      'Prompt is too long after expanding pasted content (25 chars; max 12 chars).',
    ]);
  });
});
