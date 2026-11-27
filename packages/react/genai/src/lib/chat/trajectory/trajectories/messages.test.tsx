import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Citation, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import { AgentProvider } from '../../agent-context.tsx';
import { useMessageItem, useMessagesContext } from '../messages-context.ts';
import { Messages } from './messages.tsx';

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="messages-test"
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

describe('Messages (Root)', () => {
  it('renders children inside layout wrapper', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <div>child content</div>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});

describe('Messages.List', () => {
  it('renders children in flex column', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <Messages.List>
          <div>item 1</div>
          <div>item 2</div>
        </Messages.List>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('item 1')).toBeInTheDocument();
    expect(screen.getByText('item 2')).toBeInTheDocument();
  });
});

describe('Messages.Item', () => {
  it('renders children', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Hello');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <div>item content</div>
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <ContextReader />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('role: user')).toBeInTheDocument();
  });
});

describe('Messages.UserBubble', () => {
  it('shows user text message', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('Hello world');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.UserBubble />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
        <Messages.Root messages={[message]}>
          <Messages.List>
            <Messages.Item message={message} index={0}>
              <Messages.UserBubble />
            </Messages.Item>
          </Messages.List>
        </Messages.Root>
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
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.UserBubble />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    const skill = screen
      .getByText('Revenue Analysis')
      .closest('[data-skill-id]');
    expect(skill).toHaveAttribute('data-skill-id', 'skill-123');
    expect(skill).toHaveAttribute('title', 'skill://skill-123');
    expect(skill?.className).not.toContain('bg-');
    expect(screen.queryByText(/skill:\/\//)).not.toBeInTheDocument();
  });

  it('shows alias text instead of message parts', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeUserMessage('original text', {
      metadata: { alias: 'Summarize data' },
    });
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.UserBubble />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
        <Messages.Root messages={[message]}>
          <Messages.List>
            <Messages.Item message={message} index={0}>
              <Messages.UserBubble />
            </Messages.Item>
          </Messages.List>
        </Messages.Root>
      </div>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.getByText('Summarize data').closest('[dir]')?.getAttribute('dir'),
    ).toBe('auto');
  });
});

describe('Messages.AssistantContent', () => {
  it('shows text part content', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeAssistantMessage('Here is your answer');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
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
});

describe('Messages.Thinking', () => {
  it('shows nothing when status is ready', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <Messages.Thinking />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows thinking indicator when streaming', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages} status="streaming">
        <Messages.Thinking />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows nothing while streaming before any message exists', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <Messages.Root messages={[]} status="streaming">
        <Messages.Thinking />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('Messages.Error', () => {
  it('shows nothing when no error', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    render(
      <Messages.Root messages={[]}>
        <Messages.Error />
      </Messages.Root>,
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
      <Messages.Root messages={[]}>
        <Messages.Error error={new Error('fail')} />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
  });

  it('shows error message and retry button', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const onRetry = vi.fn();
    render(
      <Messages.Root messages={[]}>
        <Messages.Error
          error={new Error('Something broke')}
          onRetry={onRetry}
        />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Something broke')).toBeInTheDocument();
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
      <Messages.Root messages={[]}>
        <Messages.Error error={new Error('fail')} onRetry={onRetry} />
      </Messages.Root>,
      { wrapper: AgentHarness },
    );

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('context hooks', () => {
  it('useMessagesContext throws outside Messages', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Bad() {
      useMessagesContext();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessagesContext must be used within <Messages>',
    );
  });

  it('useMessageItem throws outside Messages.Item', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    function Bad() {
      useMessageItem();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessageItem must be used within <Messages.Item>',
    );
  });
});

describe('Messages text citations (#5951)', () => {
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
    citation?: Parameters<typeof Messages.Root>[0]['citation'],
  ) {
    return render(
      <Messages.Root messages={messages} citation={citation}>
        <Messages.List>
          {messages.map((message, index) => (
            <Messages.Item key={message.id} message={message} index={index}>
              <Messages.AssistantContent />
            </Messages.Item>
          ))}
        </Messages.List>
      </Messages.Root>,
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

  it('keeps a source’s first number when a later message cites it again', () => {
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
    ).toEqual(['Source 1', 'Source 2', 'Source 2']);
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
