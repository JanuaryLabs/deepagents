import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
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
