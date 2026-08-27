import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { expect, test, vi } from 'vitest';

import { AgentProvider, useAgent, useAgentMessages } from './agent-context.tsx';
import { ReadOnlyChatTransport } from './read-only-transport.ts';

type SendRequest = Parameters<ChatTransport<UIMessage>['sendMessages']>[0];
type ReconnectRequest = Parameters<
  ChatTransport<UIMessage>['reconnectToStream']
>[0];

/**
 * The only stubbed seam: records every request the real `Chat` issues and
 * answers with an already-closed stream, so the status machine settles.
 */
class RecordingTransport implements ChatTransport<UIMessage> {
  readonly sends: SendRequest[] = [];
  readonly reconnects: ReconnectRequest[] = [];
  private readonly responses: UIMessageChunk[][];

  /** Each send answers with the next queued response; later sends answer empty. */
  constructor(responses: UIMessageChunk[][] = []) {
    this.responses = [...responses];
  }

  sendMessages: ChatTransport<UIMessage>['sendMessages'] = (request) => {
    this.sends.push(request);
    const chunks = this.responses.shift() ?? [];
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
  };

  reconnectToStream: ChatTransport<UIMessage>['reconnectToStream'] = (
    request,
  ) => {
    this.reconnects.push(request);
    return Promise.resolve(null);
  };
}

function SubmitHarness() {
  const { submit } = useAgent();
  return (
    <button
      type="button"
      onClick={() => submit({ prompt: 'hello', persistedPrompt: 'hello' })}
    >
      Send
    </button>
  );
}

function ErrorHarness() {
  const { error } = useAgentMessages();
  return <output>{error?.message}</output>;
}

test('submissions go through the injected transport with the caller-controlled chatId', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-1"
        transport={transport}
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    const [request] = transport.sends;
    expect(request.chatId).toBe('chat-1');
    expect(request.trigger).toBe('submit-message');
    expect(request.messages[request.messages.length - 1]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(transport.reconnects).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test('resume reconnects through the injected transport once on mount', async () => {
  const transport = new RecordingTransport();

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-9"
        transport={transport}
        resume
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await vi.waitFor(() => {
      expect(transport.reconnects).toHaveLength(1);
    });
    expect(transport.reconnects[0].chatId).toBe('chat-9');

    rerender(
      <AgentProvider
        chatId="chat-9"
        transport={transport}
        resume
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );
    expect(transport.reconnects).toHaveLength(1);
    expect(transport.sends).toHaveLength(0);
  } finally {
    cleanup();
  }
});

test('onData observes streamed data parts, transient ones included', async () => {
  const user = userEvent.setup();
  const onData = vi.fn();
  const transport = new RecordingTransport([
    [
      { type: 'data-probe', data: { hit: 1 }, transient: true },
      { type: 'data-probe', id: 'p2', data: { hit: 2 } },
    ],
  ]);

  try {
    render(
      <AgentProvider
        chatId="chat-1"
        transport={transport}
        onData={onData}
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(onData).toHaveBeenCalledTimes(2);
    });
    expect(onData).toHaveBeenNthCalledWith(1, {
      type: 'data-probe',
      data: { hit: 1 },
      transient: true,
    });
    expect(onData).toHaveBeenNthCalledWith(2, {
      type: 'data-probe',
      id: 'p2',
      data: { hit: 2 },
    });
  } finally {
    cleanup();
  }
});

test('read-only transport surfaces a send as the chat error', async () => {
  const user = userEvent.setup();

  try {
    render(
      <AgentProvider
        chatId="chat-ro"
        transport={new ReadOnlyChatTransport()}
        onResetChat={() => {}}
      >
        <SubmitHarness />
        <ErrorHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(screen.getByText(/read-only/)).toBeInTheDocument();
    });
  } finally {
    cleanup();
  }
});
