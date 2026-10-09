import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import {
  AgentProvider,
  useAgent,
  useAgentMessages,
  useAgentMeta,
} from './agent-context.tsx';

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

  uploadFile = async (sessionId: string, file: File) => ({
    path: `/workspace/.uploads/${sessionId}/${file.name}`,
    name: file.name,
    mediaType: 'image/png' as const,
    size: file.size,
    url: `https://uploads.test/${sessionId}/${file.name}`,
  });
}

class UploadingRecordingTransport extends RecordingTransport {
  readonly uploads: Array<{ sessionId: string; file: File }> = [];

  override uploadFile = async (sessionId: string, file: File) => {
    this.uploads.push({ sessionId, file });
    return {
      path: `/workspace/.uploads/${sessionId}/${file.name}`,
      name: file.name,
      mediaType: 'image/png' as const,
      size: file.size,
      url: `https://uploads.test/${sessionId}/${file.name}`,
    };
  };
}

function pngFile(): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', {
    type: 'image/png',
  });
}

function FileSubmitHarness({ file }: { file: File }) {
  const { submit } = useAgent();
  const [failure, setFailure] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void submit({
            prompt: 'look [Image #1]',
            persistedPrompt: 'look [Image #1]',
            files: [file],
          }).catch((reason: unknown) => setFailure(String(reason)))
        }
      >
        Send image
      </button>
      <output>{failure}</output>
    </>
  );
}

function SubmitHarness() {
  const { submit } = useAgent();
  return (
    <button
      type="button"
      onClick={() => void submit({ prompt: 'hello', persistedPrompt: 'hello' })}
    >
      Send
    </button>
  );
}

/** Answers each send with a stream that stays open, and records its abort signal. */
class HeldOpenTransport extends RecordingTransport {
  override sendMessages: ChatTransport<UIMessage>['sendMessages'] = (
    request,
  ) => {
    this.sends.push(request);
    return Promise.resolve(new ReadableStream<UIMessageChunk>());
  };
}

function textsOf(messages: readonly UIMessage[]): string {
  return messages
    .map((message) =>
      message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
    )
    .join('|');
}

/** Renders what a page reads from the provider: the initial-view flag and the messages. */
function ConversationProbe() {
  const { hasSubmitted } = useAgentMeta();
  const { messages } = useAgentMessages();
  const { clearChat, submit } = useAgent();
  return (
    <>
      <output aria-label="started">{String(hasSubmitted)}</output>
      <output aria-label="texts">{textsOf(messages)}</output>
      <button
        type="button"
        onClick={() =>
          void submit({ prompt: 'hello', persistedPrompt: 'hello' })
        }
      >
        Send
      </button>
      <button type="button" onClick={clearChat}>
        Clear
      </button>
    </>
  );
}

const greeting: UIMessage = {
  id: 'u1',
  role: 'user',
  parts: [{ type: 'text', text: 'earlier question' }],
};

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

test('forwards data and finish callbacks from the chat', async () => {
  const user = userEvent.setup();
  const onData = vi.fn();
  const onFinish = vi.fn();
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
        onFinish={onFinish}
        onResetChat={() => {}}
      >
        <SubmitHarness />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onFinish).toHaveBeenCalledOnce();
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
    expect(onFinish).toHaveBeenCalledWith(
      expect.objectContaining({ isAbort: false, isError: false }),
    );
  } finally {
    cleanup();
  }
});

test('uploads submission files through a transport that can store them', async () => {
  const user = userEvent.setup();
  const transport = new UploadingRecordingTransport();
  const file = pngFile();

  try {
    render(
      <AgentProvider
        chatId="chat-up"
        transport={transport}
        onResetChat={() => {}}
      >
        <FileSubmitHarness file={file} />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send image'));

    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0].sessionId).toBe('chat-up');
    expect(transport.uploads[0].file).toBe(file);
    const [request] = transport.sends;
    expect(request.messages[request.messages.length - 1]).toMatchObject({
      parts: [{ type: 'text', text: 'look [Image #1]' }],
      metadata: {
        uploads: [
          {
            path: '/workspace/.uploads/chat-up/shot.png',
            name: 'shot.png',
            mediaType: 'image/png',
            size: 4,
            url: 'https://uploads.test/chat-up/shot.png',
          },
        ],
      },
    });
  } finally {
    cleanup();
  }
});

test('shows initialMessages and reports the conversation as started on mount', () => {
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-seeded"
        transport={transport}
        initialMessages={[greeting]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe('earlier question');
    expect(screen.getByLabelText('started').textContent).toBe('true');
  } finally {
    cleanup();
  }
});

test('reports the conversation as started after a submit, and not after clearChat', async () => {
  const user = userEvent.setup();
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-fresh"
        transport={transport}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    expect(screen.getByLabelText('started').textContent).toBe('false');

    await user.click(screen.getByText('Send'));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('started').textContent).toBe('true');
    });

    await user.click(screen.getByText('Clear'));
    await vi.waitFor(() => {
      expect(screen.getByLabelText('started').textContent).toBe('false');
    });
  } finally {
    cleanup();
  }
});

test('skipInitialView reports the conversation as started with no messages', () => {
  const transport = new RecordingTransport();

  try {
    render(
      <AgentProvider
        chatId="chat-skip"
        transport={transport}
        skipInitialView
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe('');
    expect(screen.getByLabelText('started').textContent).toBe('true');
  } finally {
    cleanup();
  }
});

test('a new chatId starts a chat seeded with the initialMessages of that render', () => {
  const transport = new RecordingTransport();
  const other: UIMessage = {
    id: 'u2',
    role: 'user',
    parts: [{ type: 'text', text: 'other conversation' }],
  };

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-a"
        transport={transport}
        initialMessages={[greeting]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    rerender(
      <AgentProvider
        chatId="chat-b"
        transport={transport}
        initialMessages={[other]}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    expect(screen.getByLabelText('texts').textContent).toBe(
      'other conversation',
    );
  } finally {
    cleanup();
  }
});

test('unmount stops the stream in flight', async () => {
  const user = userEvent.setup();
  const transport = new HeldOpenTransport();

  try {
    const { unmount } = render(
      <AgentProvider
        chatId="chat-stream"
        transport={transport}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    await user.click(screen.getByText('Send'));
    await vi.waitFor(() => {
      expect(transport.sends).toHaveLength(1);
    });
    const [request] = transport.sends;
    expect(request.abortSignal?.aborted).toBe(false);

    unmount();

    expect(request.abortSignal?.aborted).toBe(true);
  } finally {
    cleanup();
  }
});

test('sends through the transport given on the latest render', async () => {
  const user = userEvent.setup();
  const first = new RecordingTransport();
  const latest = new RecordingTransport();

  try {
    const { rerender } = render(
      <AgentProvider
        chatId="chat-swap"
        transport={first}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );
    rerender(
      <AgentProvider
        chatId="chat-swap"
        transport={latest}
        onResetChat={() => {}}
      >
        <ConversationProbe />
      </AgentProvider>,
    );

    await user.click(screen.getByText('Send'));

    await vi.waitFor(() => {
      expect(latest.sends).toHaveLength(1);
    });
    expect(first.sends).toHaveLength(0);
  } finally {
    cleanup();
  }
});
