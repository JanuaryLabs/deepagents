import { cleanup, render, screen } from '@testing-library/react';
import type { ChatTransport, ToolUIPart, UIMessage } from 'ai';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { z } from 'zod';

import {
  AgentProvider,
  type ComponentRegistry,
  Messages,
  PendingToolInput,
  TimelinedMessages,
  useAgentMessages,
} from '@deepagents/react-genai';

class IdleTransport implements ChatTransport<UIMessage> {
  sendMessages: ChatTransport<UIMessage>['sendMessages'] = () =>
    Promise.reject(new Error('No sends expected'));

  reconnectToStream: ChatTransport<UIMessage>['reconnectToStream'] = () =>
    Promise.resolve(null);

  uploadFile = async (sessionId: string, file: File) => ({
    path: `/workspace/.uploads/${sessionId}/${file.name}`,
    name: file.name,
    mediaType: 'image/png' as const,
    size: file.size,
    url: `https://uploads.test/${sessionId}/${file.name}`,
  });
}

function MessagesHarness() {
  const { messages, status } = useAgentMessages();
  const message = messages[0];
  if (!message) return null;
  return (
    <Messages.Root messages={messages} status={status}>
      <Messages.Item message={message} index={0}>
        <Messages.AssistantContent />
      </Messages.Item>
    </Messages.Root>
  );
}

function TimelinedHarness() {
  const { messages, status } = useAgentMessages();
  const message = messages[0];
  if (!message) return null;
  return (
    <TimelinedMessages.Root messages={messages} status={status}>
      <TimelinedMessages.Item message={message} index={0}>
        <TimelinedMessages.AssistantContent />
      </TimelinedMessages.Item>
    </TimelinedMessages.Root>
  );
}

function renderChat(
  parts: UIMessage['parts'],
  children: ReactNode,
  options: { registry?: ComponentRegistry; debugMode?: boolean } = {},
) {
  return render(
    <AgentProvider
      chatId="tool-names-test"
      initialMessages={[{ id: 'assistant-1', role: 'assistant', parts }]}
      transport={new IdleTransport()}
      registry={options.registry}
      debugMode={options.debugMode}
      onResetChat={() => {}}
    >
      {children}
    </AgentProvider>,
  );
}

function ChartRenderer({ part }: { part: ToolUIPart }) {
  return <p>chart for {part.toolCallId}</p>;
}

const userInputRegistry: ComponentRegistry = {
  'render-chart': {
    component: ChartRenderer,
    inputSchema: z.object({}),
    description: 'Render a chart',
    requiresUserInput: true,
    static: false,
  },
};

test('a dynamic tool is labelled by its tool name', () => {
  try {
    renderChat(
      [
        {
          type: 'dynamic-tool',
          toolName: 'weather',
          toolCallId: 'call-weather',
          state: 'output-available',
          input: { city: 'Amman' },
          output: 'sunny',
        },
      ],
      <MessagesHarness />,
      { debugMode: true },
    );

    expect(screen.getByText('Executing weather')).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a static tool part renders the registry component of its tool name', () => {
  try {
    renderChat(
      [
        {
          type: 'tool-render-chart',
          toolCallId: 'call-chart',
          state: 'output-available',
          input: {},
          output: {},
        },
      ],
      <MessagesHarness />,
      {
        registry: {
          'render-chart': { component: ChartRenderer, static: true },
        },
      },
    );

    expect(screen.getByText('chart for call-chart')).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('an approval request is labelled by its tool name', () => {
  try {
    renderChat(
      [
        {
          type: 'tool-publish-report',
          toolCallId: 'call-publish',
          state: 'approval-requested',
          input: { report: 'ready' },
          approval: { id: 'approval-1' },
        },
      ],
      <MessagesHarness />,
      { registry: {} },
    );

    expect(
      screen.getByRole('group', { name: 'publish-report approval' }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a tool awaiting user input takes over the composer slot', () => {
  try {
    renderChat(
      [
        {
          type: 'tool-render-chart',
          toolCallId: 'call-input',
          state: 'input-available',
          input: {},
        },
      ],
      <PendingToolInput>
        <p>composer</p>
      </PendingToolInput>,
      { registry: userInputRegistry },
    );

    expect(screen.getByText('chart for call-input')).toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('a cancelled tool without a registry label is named by its tool name', () => {
  try {
    renderChat(
      [
        {
          type: 'tool-tool-search',
          toolCallId: 'call-search',
          state: 'input-available',
          input: { query: 'docs' },
        },
      ],
      <TimelinedHarness />,
    );

    expect(screen.getByText(/^tool-search\(/)).toBeInTheDocument();
    expect(screen.getByText('Cancelled by user')).toBeInTheDocument();
  } finally {
    cleanup();
  }
});
