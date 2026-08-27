import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ChatStatus, UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { TimelinedMessages } from './timelined-messages.tsx';

const { mockUseAgentMessages, mockUseAgentStatus } = vi.hoisted(() => ({
  mockUseAgentMessages: vi.fn(() => ({ messages: [] })),
  mockUseAgentStatus: vi.fn((): { status: ChatStatus } => ({
    status: 'ready',
  })),
}));

vi.mock('../../agent-context.tsx', () => ({
  useAgent: () => ({ debugMode: false, registry: {}, showActions: false }),
  useAgentMessages: mockUseAgentMessages,
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
  RenderPart: () => <span>tool-output</span>,
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

describe('TimelinedMessages.Root', () => {
  it('renders children inside layout', () => {
    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages}>
        <div>child content</div>
      </TimelinedMessages.Root>,
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});

describe('TimelinedMessages.AssistantContent', () => {
  it('shows text part content', () => {
    const message = makeAssistantMessage('Timeline answer');
    render(
      <TimelinedMessages.Root messages={[message]}>
        <TimelinedMessages.Item message={message} index={0}>
          <TimelinedMessages.AssistantContent />
        </TimelinedMessages.Item>
      </TimelinedMessages.Root>,
    );
    expect(screen.getByText('Timeline answer')).toBeInTheDocument();
  });

  it('shows file part info', () => {
    const message: UIMessage = {
      id: 'asst-file-tl',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          filename: 'data.csv',
          mediaType: 'text/csv',
          url: '',
        },
      ],
    };

    render(
      <TimelinedMessages.Root messages={[message]}>
        <TimelinedMessages.Item message={message} index={0}>
          <TimelinedMessages.AssistantContent />
        </TimelinedMessages.Item>
      </TimelinedMessages.Root>,
    );
    expect(screen.getByText(/data\.csv/)).toBeInTheDocument();
  });

  it('shows tool output for tool parts', () => {
    const message: UIMessage = {
      id: 'asst-tool-tl',
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
      <TimelinedMessages.Root messages={[message]}>
        <TimelinedMessages.Item message={message} index={0}>
          <TimelinedMessages.AssistantContent />
        </TimelinedMessages.Item>
      </TimelinedMessages.Root>,
    );
    expect(screen.getByText('tool-output')).toBeInTheDocument();
  });

  it('shows reasoning text with Reasoning label', () => {
    const message: UIMessage = {
      id: 'asst-reasoning-tl',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'Let me think about this carefully',
        },
      ],
    };

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TimelinedMessages.Root messages={[message]}>
          <TimelinedMessages.Item message={message} index={0}>
            <TimelinedMessages.AssistantContent />
          </TimelinedMessages.Item>
        </TimelinedMessages.Root>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Reasoning/)).toBeInTheDocument();
  });
});

describe('TimelinedMessages.Thinking', () => {
  it('shows nothing when status is ready', () => {
    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages}>
        <TimelinedMessages.Thinking />
      </TimelinedMessages.Root>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows Thinking... when streaming', () => {
    mockUseAgentStatus.mockReturnValue({ status: 'streaming' });

    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages}>
        <TimelinedMessages.Thinking />
      </TimelinedMessages.Root>,
    );
    expect(screen.getByText('Thinking...')).toBeInTheDocument();

    mockUseAgentStatus.mockReturnValue({ status: 'ready' });
  });
});

describe('full composition', () => {
  it('renders user and assistant messages together', () => {
    const userMsg = makeUserMessage('What is sales?');
    const assistantMsg = makeAssistantMessage('Sales data shows...');

    render(
      <TimelinedMessages.Root messages={[userMsg, assistantMsg]}>
        <TimelinedMessages.List>
          <TimelinedMessages.Item message={userMsg} index={0}>
            <TimelinedMessages.UserBubble />
          </TimelinedMessages.Item>
          <TimelinedMessages.Item message={assistantMsg} index={1}>
            <TimelinedMessages.AssistantContent />
          </TimelinedMessages.Item>
        </TimelinedMessages.List>
      </TimelinedMessages.Root>,
    );

    expect(screen.getByText('What is sales?')).toBeInTheDocument();
    expect(screen.getByText('Sales data shows...')).toBeInTheDocument();
  });
});
