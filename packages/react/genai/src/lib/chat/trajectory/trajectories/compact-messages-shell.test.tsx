import { createClock } from '@sinonjs/fake-timers';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClockProvider } from '@zukhruf/ui';
import type { Citation, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import type { GenAIInteractiveElement } from '../../../elements/interactive-element.ts';
import type { ComponentRegistry } from '../../../tools/registry.ts';
import { AgentProvider } from '../../agent-context.tsx';
import { useMessageItem, useMessagesContext } from '../messages-context.ts';
import { CompactMessages } from './compact-messages.tsx';

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="compact-messages-shell-test"
      debugMode={false}
      registry={{}}
      transport={new StoredMessagesTransport()}
      onResetChat={() => undefined}
    >
      {children}
    </AgentProvider>
  );
}

let messageCounter = 0;

function makeUserMessage(
  text: string,
  overrides?: Partial<UIMessage>,
): UIMessage {
  return {
    id: `user-${++messageCounter}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...overrides,
  };
}

function makeAssistantMessage(
  text: string,
  overrides?: Partial<UIMessage>,
): UIMessage {
  return {
    id: `asst-${++messageCounter}`,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    ...overrides,
  };
}

describe('CompactMessages.Root', () => {
  it('renders children inside layout wrapper', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <CompactMessages.Root messages={messages}>
        <div>child content</div>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});

describe('CompactMessages.List', () => {
  it('renders children in flex column', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <CompactMessages.Root messages={messages}>
        <CompactMessages.List>
          <div>item 1</div>
          <div>item 2</div>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('item 1')).toBeInTheDocument();
    expect(screen.getByText('item 2')).toBeInTheDocument();
  });
});

describe('CompactMessages.Item', () => {
  it('renders children', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Hello');
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <div>item content</div>
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('item content')).toBeInTheDocument();
  });

  it('provides message context to children', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Context test');

    function ContextReader() {
      const { message: msg } = useMessageItem();
      return <span>role: {msg.role}</span>;
    }

    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <ContextReader />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('role: user')).toBeInTheDocument();
  });
});

describe('CompactMessages.UserBubble', () => {
  it('shows user text message', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Hello world');
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.UserBubble />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('in a right-to-left page a user message takes its own text direction (#5919)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Hello world');
    render(
      <div dir="rtl">
        <CompactMessages.Root messages={[message]}>
          <CompactMessages.List>
            <CompactMessages.Item message={message} index={0}>
              <CompactMessages.UserBubble />
            </CompactMessages.Item>
          </CompactMessages.List>
        </CompactMessages.Root>
      </div>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.getByText('Hello world').closest('[dir]')?.getAttribute('dir'),
    ).toBe('auto');
  });

  it('renders persisted skill links as inline skill references', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage(
      'Use [$Revenue Analysis](skill://skill-123) for Q2.',
    );
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.UserBubble />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );

    const skill = screen
      .getByText('Revenue Analysis')
      .closest('[data-skill-id]');
    expect(skill).toHaveAttribute('data-skill-id', 'skill-123');
    expect(skill).toHaveAttribute('title', 'skill://skill-123');
    expect(skill?.className).not.toContain('bg-');
    expect(
      Array.from(skill?.querySelectorAll('svg') ?? [], (icon) =>
        icon.getAttribute('class'),
      ),
    ).toEqual(['lucide lucide-package size-3.5 self-center']);
    expect(screen.queryByText(/skill:\/\//)).not.toBeInTheDocument();
  });

  it('shows alias text instead of message parts', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('original text', {
      metadata: { alias: 'Summarize data' },
    });
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.UserBubble />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Summarize data')).toBeInTheDocument();
    expect(screen.queryByText('original text')).not.toBeInTheDocument();
  });

  it('in a right-to-left page an aliased user message takes its own text direction (#5919)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('original text', {
      metadata: { alias: 'Summarize data' },
    });
    render(
      <div dir="rtl">
        <CompactMessages.Root messages={[message]}>
          <CompactMessages.List>
            <CompactMessages.Item message={message} index={0}>
              <CompactMessages.UserBubble />
            </CompactMessages.Item>
          </CompactMessages.List>
        </CompactMessages.Root>
      </div>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.getByText('Summarize data').closest('[dir]')?.getAttribute('dir'),
    ).toBe('auto');
  });
});

describe('CompactMessages.AssistantContent', () => {
  it('shows text part content', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeAssistantMessage('Here is your answer');
    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Here is your answer')).toBeInTheDocument();
  });

  it('shows file part info', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message: UIMessage = {
      id: 'asst-file',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          filename: 'output.json',
          mediaType: 'application/json',
          url: '',
        },
      ],
    };

    render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/output\.json/)).toBeInTheDocument();
  });

  it('plays a video file part inline and offers a download link', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message: UIMessage = {
      id: 'asst-video',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          filename: 'highlight.mp4',
          mediaType: 'video/mp4',
          url: 'https://reels.test/highlight.mp4',
        },
      ],
    };

    const { container } = render(
      <CompactMessages.Root messages={[message]}>
        <CompactMessages.List>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', 'https://reels.test/highlight.mp4');
    expect(video).toHaveAttribute('controls');
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      'https://reels.test/highlight.mp4',
    );
    expect(screen.getByText(/highlight\.mp4/)).toBeInTheDocument();
  });

  it('shows tool output for tool parts', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const registry: ComponentRegistry = {
      executeQuery: {
        static: true,
        component: () => <span>tool-output</span>,
      },
    };
    const message: UIMessage = {
      id: 'asst-tool',
      role: 'assistant',
      parts: [
        {
          type: 'tool-executeQuery',
          toolCallId: 'tc-1',
          state: 'output-available',
          input: {},
          output: 'result',
        },
      ],
    };

    render(
      <AgentProvider
        chatId="compact-messages-shell-tool-test"
        debugMode={false}
        registry={registry}
        transport={new StoredMessagesTransport()}
        onResetChat={() => undefined}
      >
        <CompactMessages.Root messages={[message]}>
          <CompactMessages.Item message={message} index={0}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.Root>
      </AgentProvider>,
    );
    expect(screen.getByText('tool-output')).toBeInTheDocument();
  });
});

describe('CompactMessages.Thinking', () => {
  it('shows nothing when status is ready', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <CompactMessages.Root messages={messages}>
        <CompactMessages.Thinking />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows thinking indicator when streaming', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <CompactMessages.Root messages={messages} status="streaming">
        <CompactMessages.Thinking />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows nothing while streaming before any message exists', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <CompactMessages.Root messages={[]} status="streaming">
        <CompactMessages.Thinking />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('CompactMessages.Error', () => {
  it('shows nothing when no error', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <CompactMessages.Root messages={[]}>
        <CompactMessages.Error />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
  });

  it('shows nothing when no onRetry', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <CompactMessages.Root messages={[]}>
        <CompactMessages.Error error={new Error('fail')} />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the catalog sentence, not the error message, and the retry button', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const onRetry = vi.fn();
    render(
      <CompactMessages.Root messages={[]}>
        <CompactMessages.Error
          error={new Error('Something broke')}
          onRetry={onRetry}
        />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong. Try again.',
    );
    expect(screen.queryByText('Something broke')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <CompactMessages.Root messages={[]}>
        <CompactMessages.Error error={new Error('fail')} onRetry={onRetry} />
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('context hooks', () => {
  it('useMessagesContext throws outside CompactMessages.Root', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Bad() {
      useMessagesContext();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessagesContext must be used within <CompactMessages.Root>',
    );
  });

  it('useMessageItem throws outside CompactMessages.Item', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Bad() {
      useMessageItem();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessageItem must be used within <CompactMessages.Item>',
    );
  });
});

describe('CompactMessages full composition', () => {
  it('renders user and assistant messages together', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const userMsg = makeUserMessage('What is sales?');
    const assistantMsg = makeAssistantMessage('Sales data shows...');

    render(
      <CompactMessages.Root messages={[userMsg, assistantMsg]}>
        <CompactMessages.List>
          <CompactMessages.Item message={userMsg} index={0}>
            <CompactMessages.UserBubble />
          </CompactMessages.Item>
          <CompactMessages.Item message={assistantMsg} index={1}>
            <CompactMessages.AssistantContent />
          </CompactMessages.Item>
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );

    expect(screen.getByText('What is sales?')).toBeInTheDocument();
    expect(screen.getByText('Sales data shows...')).toBeInTheDocument();
  });
});

describe('CompactMessages text citations (#5951)', () => {
  function urlCitation(
    url: string,
    endIndex?: number,
    citedText?: string,
  ): Citation {
    return {
      source: { type: 'source', sourceType: 'url', id: url, url, title: url },
      ...(endIndex === undefined ? {} : { startIndex: 0, endIndex }),
      ...(citedText === undefined ? {} : { citedText }),
    };
  }

  function citedAnswer(text: string, citations: Citation[]): UIMessage {
    return {
      id: `asst-${++messageCounter}`,
      role: 'assistant',
      parts: [{ type: 'text', text, citations }],
    };
  }

  function renderAnswers(
    messages: UIMessage[],
    citation?: Parameters<typeof CompactMessages.Root>[0]['citation'],
  ) {
    return render(
      <CompactMessages.Root messages={messages} citation={citation}>
        <CompactMessages.List>
          {messages.map((message, index) => (
            <CompactMessages.Item
              key={message.id}
              message={message}
              index={index}
            >
              <CompactMessages.AssistantContent />
            </CompactMessages.Item>
          ))}
        </CompactMessages.List>
      </CompactMessages.Root>,
      { wrapper: AgentHarness },
    );
  }

  it('draws each citation inline where it points, numbered in the order the chat first cites it', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    // A real Meddit sentence; each citation sits where the model's marker was.
    const first = 'Apixaban needs no change in mild impairment.';
    const text = `${first} Use **Cockcroft-Gault CrCl, not eGFR** for dosing.`;
    renderAnswers([
      citedAnswer(text, [
        urlCitation('https://pubmed.example/1', first.length),
        urlCitation('https://pubmed.example/2', text.length - 1),
      ]),
    ]);

    const pills = screen.getAllByRole('button', { name: /^Source / });
    expect({
      names: pills.map((pill) => pill.getAttribute('aria-label')),
      sentence: pills[0]?.closest('p')?.textContent,
      oneParagraph: pills[0]?.closest('p') === pills[1]?.closest('p'),
    }).toEqual({
      names: ['Source 1', 'Source 2'],
      sentence:
        'Apixaban needs no change in mild impairment.1 Use Cockcroft-Gault CrCl, not eGFR for dosing2.',
      oneParagraph: true,
    });
  });

  it('draws a citation with no offset, as Anthropic sends it, at the end of its text', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderAnswers([
      citedAnswer('Apixaban needs no change in mild impairment.', [
        urlCitation('https://pubmed.example/1'),
      ]),
    ]);

    expect(
      screen.getByRole('button', { name: 'Source 1' }).closest('p')
        ?.textContent,
    ).toBe('Apixaban needs no change in mild impairment.1');
  });

  it('numbers each answer’s sources from 1, so a follow-up that cites an earlier source starts again at 1 (#6022)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderAnswers([
      citedAnswer('First claim.', [
        urlCitation('https://pubmed.example/1'),
        urlCitation('https://pubmed.example/2'),
      ]),
      citedAnswer('Follow-up claim.', [
        urlCitation('https://pubmed.example/2'),
      ]),
    ]);

    expect(
      screen
        .getAllByRole('button', { name: /^Source / })
        .map((pill) => pill.getAttribute('aria-label')),
    ).toEqual(['Source 1', 'Source 2', 'Source 1']);
  });

  it('numbers an answer’s sources in reading order, whatever order its citations arrive in (#6022)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const first = 'Apixaban needs no change in mild impairment.';
    const text = `${first} Use Cockcroft-Gault CrCl for dosing.`;
    renderAnswers([
      citedAnswer(text, [
        urlCitation('https://pubmed.example/later', text.length),
        urlCitation('https://pubmed.example/earlier', first.length),
      ]),
    ]);

    expect(
      screen.getByRole('button', { name: 'Source 1' }).closest('p')
        ?.textContent,
    ).toBe(
      'Apixaban needs no change in mild impairment.1 Use Cockcroft-Gault CrCl for dosing.2',
    );
  });

  it('draws a source that is both a source-url part and a text citation once, inline, still draws a source nobody cites, and numbers them in the order they are drawn (#6022)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const text = 'Apixaban needs no change in mild impairment.';
    const cited = 'https://pubmed.example/1';
    const message: UIMessage = {
      id: 'asst-cited-source-url',
      role: 'assistant',
      parts: [
        { type: 'source-url', sourceId: 's1', url: cited, title: 'Cited' },
        {
          type: 'source-url',
          sourceId: 's2',
          url: 'https://pubmed.example/2',
          title: 'Listed',
        },
        {
          type: 'text',
          text,
          citations: [
            {
              source: {
                type: 'source',
                sourceType: 'url',
                id: 's1',
                url: cited,
                title: 'Cited',
              },
              startIndex: 0,
              endIndex: text.length,
            },
          ],
        },
      ],
    };
    renderAnswers([message]);

    const pills = screen.getAllByRole('button', { name: /^Source / });
    expect({
      names: pills.map((pill) => pill.getAttribute('aria-label')),
      firstInSentence: pills[0]?.closest('p')?.textContent,
    }).toEqual({
      names: ['Source 1', 'Source 2'],
      firstInSentence: undefined,
    });
  });

  it('copies an answer without the markup of its declared elements, keeping a paired element’s words and code as written (#6048)', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
      },
    });
    stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));

    const first = 'Apixaban needs no change in mild impairment.';
    const text = `${first} <no-source passage="S1" reason="a > b" /> <passage-cite passage="p1">See the label</passage-cite> and \`<keep-this x="1" />\` stays.`;
    const answer: UIMessage = {
      id: `asst-${++messageCounter}`,
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text,
          citations: [
            {
              source: {
                type: 'source',
                sourceType: 'url',
                id: 'label',
                url: 'https://label.example/apixaban',
                title: 'Apixaban label',
              },
              startIndex: 0,
              endIndex: first.length,
            },
          ],
        },
      ],
    };
    const elements = ['no-source', 'passage-cite', 'keep-this'].map(
      (name): GenAIInteractiveElement => ({
        name,
        allowedAttributes: ['passage', 'reason', 'x'],
        component: () => null,
      }),
    );
    render(
      <ClockProvider clock={createClock()}>
        <CompactMessages.Root messages={[answer]} elements={elements}>
          <CompactMessages.Item message={answer} index={0}>
            <CompactMessages.CopyAction />
          </CompactMessages.Item>
        </CompactMessages.Root>
      </ClockProvider>,
      { wrapper: AgentHarness },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(copied).toBe(
      [
        'Apixaban needs no change in mild impairment.[1] See the label and `<keep-this x="1" />` stays.',
        '',
        '[1] Apixaban label — https://label.example/apixaban',
      ].join('\n'),
    );
  });

  it('copies an answer with each citation as [n] where it sits and the numbered sources after it (#5995)', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
      },
    });
    stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));

    const first = 'Apixaban needs no change in mild impairment.';
    const text = `${first} Use Cockcroft-Gault CrCl for dosing.`;
    const answer: UIMessage = {
      id: `asst-${++messageCounter}`,
      role: 'assistant',
      parts: [
        {
          type: 'text',
          text,
          citations: [
            {
              source: {
                type: 'source',
                sourceType: 'url',
                id: 'review',
                url: 'https://pubmed.example/2',
                title: 'Renal dosing review',
              },
              startIndex: 0,
              endIndex: text.length - 1,
            },
            {
              source: {
                type: 'source',
                sourceType: 'url',
                id: 'label',
                url: 'https://label.example/apixaban',
                title: 'Apixaban label',
              },
              startIndex: 0,
              endIndex: first.length,
            },
          ],
        },
        {
          type: 'source-url',
          sourceId: 'listed',
          url: 'https://listed.example/review',
        },
      ],
    };
    render(
      <ClockProvider clock={createClock()}>
        <CompactMessages.Root messages={[answer]}>
          <CompactMessages.Item message={answer} index={0}>
            <CompactMessages.CopyAction />
          </CompactMessages.Item>
        </CompactMessages.Root>
      </ClockProvider>,
      { wrapper: AgentHarness },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(copied).toBe(
      [
        'Apixaban needs no change in mild impairment.[1] Use Cockcroft-Gault CrCl for dosing[2].',
        '',
        '[1] Apixaban label — https://label.example/apixaban',
        '[2] Renal dosing review — https://pubmed.example/2',
        '[3] https://listed.example/review',
      ].join('\n'),
    );
  });

  it('draws a citation through the host’s citation component, with its citation and number', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    renderAnswers(
      [
        citedAnswer('Apixaban needs no change in mild impairment.', [
          urlCitation('https://pubmed.example/7', undefined, 'no dose change'),
        ]),
      ],
      ({ citation, index }) => (
        <sup data-testid="host-cite">{`${index}:${citation.citedText}`}</sup>
      ),
    );

    expect({
      drawn: screen.getByTestId('host-cite').textContent,
      defaultPill: screen.queryByRole('button', { name: /^Source / }),
    }).toEqual({ drawn: '1:no dose change', defaultPill: null });
  });

  it('shows the cited text in the default citation’s detail', async () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);
    const user = userEvent.setup();

    renderAnswers([
      citedAnswer('Apixaban needs no change in mild impairment.', [
        urlCitation(
          'https://pubmed.example/1',
          undefined,
          'no dose change is needed',
        ),
      ]),
    ]);

    await user.click(screen.getByRole('button', { name: 'Source 1' }));

    expect(screen.getByText('no dose change is needed')).toBeInTheDocument();
  });
});

describe('CompactMessages copy of a host’s declared elements (#6090)', () => {
  function declared(name: string): GenAIInteractiveElement {
    return {
      name,
      allowedAttributes: ['question'],
      component: ({ question }) => (
        <button type="button">{String(question)}</button>
      ),
    };
  }

  async function copyOf(
    stack: DisposableStack,
    answer: UIMessage,
    elements: GenAIInteractiveElement[],
  ) {
    stack.defer(cleanup);
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied = text;
          return Promise.resolve();
        },
      },
    });
    stack.defer(() => Reflect.deleteProperty(navigator, 'clipboard'));
    render(
      <ClockProvider clock={createClock()}>
        <CompactMessages.Root messages={[answer]} elements={elements}>
          <CompactMessages.Item message={answer} index={0}>
            <CompactMessages.AssistantContent />
            <CompactMessages.CopyAction />
          </CompactMessages.Item>
        </CompactMessages.Root>
      </ClockProvider>,
      { wrapper: AgentHarness },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    return copied;
  }

  it.each([
    ['followup', 'paired'],
    ['followup', 'self-closing'],
    ['follow-up', 'paired'],
    ['follow-up', 'self-closing'],
  ])(
    'a declared <%s> element written %s shows as its component, and Copy gives the sentence without its tags',
    async (name, form) => {
      using stack = new DisposableStack();
      const sentence = 'The paint dries in an hour.';
      const tag =
        form === 'paired'
          ? `<${name} question="Next?"></${name}>`
          : `<${name} question="Next?" />`;
      const answer = makeAssistantMessage(`${sentence} ${tag}`);

      const copied = await copyOf(stack, answer, [declared(name)]);

      expect({
        element: screen.queryByRole('button', { name: 'Next?' }) !== null,
        rawTagOnScreen: screen.queryByText(new RegExp(`<${name}`)) !== null,
        copied: copied.trimEnd(),
      }).toEqual({ element: true, rawTagOnScreen: false, copied: sentence });
    },
  );

  it('copies an empty declared element between two sentences with one space between them', async () => {
    using stack = new DisposableStack();
    const answer = makeAssistantMessage(
      'The paint dries in an hour. <followup question="Next?"></followup> Then add a second coat.',
    );

    const copied = await copyOf(stack, answer, [declared('followup')]);

    expect(copied).toBe('The paint dries in an hour. Then add a second coat.');
  });

  it('copies tag-like text the host did not declare as written', async () => {
    using stack = new DisposableStack();
    const text =
      'The paint is <b>dry</b> when x < y > z, and <no-source passage="S1" /> stays.';
    const answer = makeAssistantMessage(
      `${text} <followup question="Next?" />`,
    );

    const copied = await copyOf(stack, answer, [declared('followup')]);

    expect(copied.trimEnd()).toBe(text);
  });
});
