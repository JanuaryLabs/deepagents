import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatStatus, UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { useMessageItem, useMessagesContext } from '../messages-context.ts';
import { Messages } from './messages.tsx';

const { mockUseAgentStatus } = vi.hoisted(() => ({
  mockUseAgentStatus: vi.fn((): { status: ChatStatus } => ({
    status: 'ready',
  })),
}));

vi.mock('../../agent-context.tsx', () => ({
  useAgent: () => ({ debugMode: false, registry: {}, showActions: false }),
  useAgentStatus: mockUseAgentStatus,
}));

vi.mock('../../../copy/assistant-snapshot.tsx', () => ({
  useIsAssistantSnapshotRender: () => false,
}));

vi.mock('../../../components/InteractiveResponse.tsx', () => ({
  InteractiveResponse: ({ children }: { children: string }) => (
    <span>{children}</span>
  ),
}));

vi.mock('../../../renderers/render-part.tsx', () => ({
  RenderPart: () => null,
}));

vi.mock('../../../components/tool-debug.tsx', () => ({
  ToolDebug: () => null,
  DynamicToolDebug: () => null,
}));

vi.mock('../../../elements/Response.tsx', () => ({
  Response: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock('../../usage.ts', () => ({
  parseMetadataUsage: () => null,
  formatUsageBreakdown: () => '',
}));

vi.mock('@deepagents/context/browser', () => ({
  stripReminders: (msg: UIMessage) => msg,
}));

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
    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <div>child content</div>
      </Messages.Root>,
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});

describe('Messages.List', () => {
  it('renders children in flex column', () => {
    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <Messages.List>
          <div>item 1</div>
          <div>item 2</div>
        </Messages.List>
      </Messages.Root>,
    );
    expect(screen.getByText('item 1')).toBeInTheDocument();
    expect(screen.getByText('item 2')).toBeInTheDocument();
  });
});

describe('Messages.Item', () => {
  it('renders children', () => {
    const message = makeUserMessage('Hello');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <div>item content</div>
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
    );
    expect(screen.getByText('item content')).toBeInTheDocument();
  });

  it('provides message context to children', () => {
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
    );
    expect(screen.getByText('role: user')).toBeInTheDocument();
  });
});

describe('Messages.UserBubble', () => {
  it('shows user text message', () => {
    const message = makeUserMessage('Hello world');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.UserBubble />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
    );
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('renders persisted skill links as inline skill references', () => {
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
    );
    expect(screen.getByText('Summarize data')).toBeInTheDocument();
    expect(screen.queryByText('original text')).not.toBeInTheDocument();
  });

  it('shows file info for file parts', () => {
    const message: UIMessage = {
      id: 'user-file',
      role: 'user',
      parts: [
        {
          type: 'file',
          filename: 'report.csv',
          mediaType: 'text/csv',
          url: '',
        },
      ],
    };

    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.UserBubble />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
    );
    expect(screen.getByText(/report\.csv/)).toBeInTheDocument();
  });
});

describe('Messages.AssistantContent', () => {
  it('shows text part content', () => {
    const message = makeAssistantMessage('Here is your answer');
    render(
      <Messages.Root messages={[message]}>
        <Messages.List>
          <Messages.Item message={message} index={0}>
            <Messages.AssistantContent />
          </Messages.Item>
        </Messages.List>
      </Messages.Root>,
    );
    expect(screen.getByText('Here is your answer')).toBeInTheDocument();
  });

  it('shows file part info', () => {
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
    );
    expect(screen.getByText(/output\.json/)).toBeInTheDocument();
  });
});

describe('Messages.Thinking', () => {
  it('shows nothing when status is ready', () => {
    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <Messages.Thinking />
      </Messages.Root>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows thinking indicator when streaming', () => {
    mockUseAgentStatus.mockReturnValue({ status: 'streaming' });

    const messages = [makeUserMessage('Hello')];
    render(
      <Messages.Root messages={messages}>
        <Messages.Thinking />
      </Messages.Root>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();

    mockUseAgentStatus.mockReturnValue({ status: 'ready' });
  });
});

describe('Messages.Error', () => {
  it('shows nothing when no error', () => {
    render(
      <Messages.Root messages={[]}>
        <Messages.Error />
      </Messages.Root>,
    );
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
  });

  it('shows nothing when no onRetry', () => {
    render(
      <Messages.Root messages={[]}>
        <Messages.Error error={new Error('fail')} />
      </Messages.Root>,
    );
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
  });

  it('shows error message and retry button', () => {
    const onRetry = vi.fn();
    render(
      <Messages.Root messages={[]}>
        <Messages.Error
          error={new Error('Something broke')}
          onRetry={onRetry}
        />
      </Messages.Root>,
    );
    expect(screen.getByText('Something broke')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <Messages.Root messages={[]}>
        <Messages.Error error={new Error('fail')} onRetry={onRetry} />
      </Messages.Root>,
    );

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('context hooks', () => {
  it('useMessagesContext throws outside Messages', () => {
    function Bad() {
      useMessagesContext();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessagesContext must be used within <Messages>',
    );
  });

  it('useMessageItem throws outside Messages.Item', () => {
    function Bad() {
      useMessageItem();
      return null;
    }
    expect(() => render(<Bad />)).toThrow(
      'useMessageItem must be used within <Messages.Item>',
    );
  });
});
