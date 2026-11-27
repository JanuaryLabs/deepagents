import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { StoredMessagesTransport } from '../../../../testing/stored-messages-transport.ts';
import type { ComponentRegistry } from '../../../tools/registry.ts';
import { AgentProvider } from '../../agent-context.tsx';
import { TimelinedMessages } from './timelined-messages.tsx';

const registry: ComponentRegistry = {
  executeQuery: {
    static: true,
    component: () => <span>tool-output</span>,
  },
};

function AgentHarness({ children }: { children: ReactNode }) {
  return (
    <AgentProvider
      chatId="timelined-messages-test"
      debugMode={false}
      registry={registry}
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

describe('TimelinedMessages.Root', () => {
  it('renders children inside layout', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages}>
        <div>child content</div>
      </TimelinedMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });
});

describe('TimelinedMessages.AssistantContent', () => {
  it('shows text part content', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const message = makeAssistantMessage('Timeline answer');
    render(
      <TimelinedMessages.Root messages={[message]}>
        <TimelinedMessages.Item message={message} index={0}>
          <TimelinedMessages.AssistantContent />
        </TimelinedMessages.Item>
      </TimelinedMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Timeline answer')).toBeInTheDocument();
  });

  it('shows file part info', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

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
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/data\.csv/)).toBeInTheDocument();
  });

  it('shows tool output for tool parts', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

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
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('tool-output')).toBeInTheDocument();
  });

  it('shows reasoning text with Reasoning label', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

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
      { wrapper: AgentHarness },
    );
    expect(screen.getByText(/Reasoning/)).toBeInTheDocument();
  });
});

describe('TimelinedMessages.Thinking', () => {
  it('shows nothing when status is ready', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages}>
        <TimelinedMessages.Thinking />
      </TimelinedMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows Thinking... when streaming', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const messages = [makeUserMessage('Hello')];
    render(
      <TimelinedMessages.Root messages={messages} status="streaming">
        <TimelinedMessages.Thinking />
      </TimelinedMessages.Root>,
      { wrapper: AgentHarness },
    );
    expect(screen.getByText('Thinking...')).toBeInTheDocument();
  });
});

describe('full composition', () => {
  it('renders user and assistant messages together', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

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
      { wrapper: AgentHarness },
    );

    expect(screen.getByText('What is sales?')).toBeInTheDocument();
    expect(screen.getByText('Sales data shows...')).toBeInTheDocument();
  });
});

describe('TimelinedMessages text citations (#5951)', () => {
  it('draws a source that is both a source-url part and a text citation once, inline, still draws a source nobody cites, and numbers them in the order they are drawn (#6022)', () => {
    using stack = new DisposableStack();
    stack.defer(cleanup);

    const text = 'Apixaban needs no change in mild impairment.';
    const cited = 'https://pubmed.example/1';
    const message: UIMessage = {
      id: 'asst-cited-tl',
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
    render(
      <TimelinedMessages.Root messages={[message]}>
        <TimelinedMessages.Item message={message} index={0}>
          <TimelinedMessages.AssistantContent />
        </TimelinedMessages.Item>
      </TimelinedMessages.Root>,
      { wrapper: AgentHarness },
    );

    const pills = screen.getAllByRole('button', { name: /^Source / });
    expect({
      names: pills.map((pill) => pill.getAttribute('aria-label')),
      firstInSentence: pills[0]?.closest('p')?.textContent,
    }).toEqual({
      names: ['Source 1', 'Source 2'],
      firstInSentence: undefined,
    });
  });
});
