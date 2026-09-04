import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';

import { AgentProvider, useAgent } from './agent-context.tsx';

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
    mediaType: file.type,
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
      mediaType: file.type,
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
          submit({
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
      onClick={() => submit({ prompt: 'hello', persistedPrompt: 'hello' })}
    >
      Send
    </button>
  );
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
