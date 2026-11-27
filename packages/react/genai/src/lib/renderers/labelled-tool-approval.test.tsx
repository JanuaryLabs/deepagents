import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChatTransport, UIMessage } from 'ai';
import { expect, test } from 'vitest';

import {
  AgentProvider,
  CompactMessages,
  type ComponentRegistry,
  useAgentMessages,
} from '@deepagents/react-genai';

class IdleTransport implements ChatTransport<UIMessage> {
  sendMessages: ChatTransport<UIMessage>['sendMessages'] = () =>
    Promise.reject(new Error('No send expected'));

  reconnectToStream: ChatTransport<UIMessage>['reconnectToStream'] = () =>
    Promise.resolve(null);

  uploadFile = async (sessionId: string, file: File) => ({
    path: `/workspace/.uploads/${sessionId}/${file.name}`,
    name: file.name,
    mediaType: 'image/png' as const,
    size: file.size,
    url: `https://uploads.test/${sessionId}/${file.name}`,
  });

  cancel = async () => {};
}

const registry: ComponentRegistry = {
  publish: {
    static: true,
    component: () => null,
    label: () => ({ name: 'publish', args: { report: 'q3' } }),
  },
};

const approvalMessage: UIMessage = {
  id: 'approval-request',
  role: 'assistant',
  parts: [
    {
      type: 'tool-publish',
      toolCallId: 'call-1',
      state: 'approval-requested',
      input: { report: 'q3' },
      approval: { id: 'approval-1', requestReason: 'Publish the report?' },
    },
  ],
};

function Conversation() {
  const { messages, status } = useAgentMessages();
  return (
    <CompactMessages.Root messages={messages} status={status}>
      {messages.map((message, index) => (
        <CompactMessages.Item key={message.id} message={message} index={index}>
          <CompactMessages.AssistantContent />
        </CompactMessages.Item>
      ))}
    </CompactMessages.Root>
  );
}

function renderApproval() {
  return render(
    <AgentProvider
      chatId="labelled-tool-approval"
      initialMessages={[approvalMessage]}
      transport={new IdleTransport()}
      registry={registry}
      onResetChat={() => {}}
    >
      <Conversation />
    </AgentProvider>,
  );
}

test('a labelled tool waiting for approval shows Approve and Deny without a click', () => {
  try {
    renderApproval();

    expect({
      reason: screen.queryByText('Publish the report?') !== null,
      buttons: ['Approve', 'Deny'].filter(
        (name) => screen.queryByRole('button', { name }) !== null,
      ),
    }).toEqual({ reason: true, buttons: ['Approve', 'Deny'] });
  } finally {
    cleanup();
  }
});

test('a labelled tool step closes once the user answers its approval', async () => {
  const user = userEvent.setup();
  try {
    renderApproval();
    const stepRow = () => screen.getByRole('button', { name: /^publish\(/ });
    const openWhileWaiting = stepRow().getAttribute('aria-expanded');

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect({
      openWhileWaiting,
      openAfterAnswer: stepRow().getAttribute('aria-expanded'),
    }).toEqual({ openWhileWaiting: 'true', openAfterAnswer: 'false' });
  } finally {
    cleanup();
  }
});
