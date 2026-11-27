import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { ChatStatus, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { StoredMessagesTransport } from '../../testing/stored-messages-transport.ts';
import { AgentProvider } from '../chat/agent-context.tsx';
import { CompactMessages } from '../chat/trajectory/trajectories/compact-messages.tsx';
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
