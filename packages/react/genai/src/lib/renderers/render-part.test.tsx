import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChatTransport, UIMessage } from 'ai';
import { expect, test, vi } from 'vitest';

import {
  AgentProvider,
  Messages,
  useAgentMessages,
} from '@deepagents/react-genai';

type SendRequest = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];

class RecordingTransport implements ChatTransport<UIMessage> {
  readonly sends: SendRequest[] = [];

  sendMessages: ChatTransport<UIMessage>['sendMessages'] = (request) => {
    this.sends.push({
      ...request,
      messages: structuredClone(request.messages),
    });
    return Promise.reject(new Error('Approval continuation recorded'));
  };

  reconnectToStream: ChatTransport<UIMessage>['reconnectToStream'] = () =>
    Promise.resolve(null);
}

const approvalMessage: UIMessage = {
  id: 'approval-request',
  role: 'assistant',
  parts: [
    {
      type: 'tool-publish',
      toolCallId: 'call-1',
      state: 'approval-requested',
      input: { report: 'ready' },
      approval: {
        id: 'approval-1',
        requestReason: 'Publish the report?',
      },
    },
  ],
};

function ApprovalHarness() {
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

function renderApproval(transport: ChatTransport<UIMessage>) {
  return render(
    <AgentProvider
      chatId="approval-test"
      initialMessages={[approvalMessage]}
      transport={transport}
      onResetChat={() => {}}
    >
      <ApprovalHarness />
    </AgentProvider>,
  );
}

test('user can approve a native tool request', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    renderApproval(transport);

    expect(screen.getByText('Publish the report?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0]).toMatchObject({
      trigger: 'submit-message',
      messages: [
        {
          parts: [
            {
              state: 'approval-responded',
              approval: { id: 'approval-1', approved: true },
            },
          ],
        },
      ],
    });
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
  }
});

test('user can deny a native tool request without entering a reason', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    renderApproval(transport);

    await user.click(screen.getByRole('button', { name: 'Deny' }));

    await vi.waitFor(() => expect(transport.sends).toHaveLength(1));
    expect(transport.sends[0]).toMatchObject({
      trigger: 'submit-message',
      messages: [
        {
          parts: [
            {
              state: 'approval-responded',
              approval: { id: 'approval-1', approved: false },
            },
          ],
        },
      ],
    });
    expect(
      screen.queryByRole('button', { name: 'Deny' }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
  }
});
