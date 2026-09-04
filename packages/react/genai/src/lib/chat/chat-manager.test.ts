import { Chat, type UseChatHelpers, useChat } from '@ai-sdk/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  ChatStatus,
  ChatTransport,
  UIDataTypes,
  UIMessage,
  UIMessageChunk,
  UITools,
} from 'ai';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';

import {
  ChatManager,
  type ChatManagerOptions,
  type ChatSubmission,
} from './chat-manager.ts';
import { type PendingPrefill, writePrefill } from './prefill.ts';

type TestUIMessage = UIMessage<unknown, UIDataTypes, UITools>;
type TestChatHelpers = UseChatHelpers<TestUIMessage>;

const PREFILL_STORAGE_KEY = 'pending-chat-prefill';

/**
 * A single in-flight response stream the test controls by hand. The chat stays
 * busy ('submitted'/'streaming') while a stream is open and transitions to
 * 'ready' once it is closed, mirroring how a real network response drives the
 * AI SDK's status machine.
 */
interface OpenStream {
  readonly stream: ReadableStream<UIMessageChunk>;
  readonly closed: boolean;
  emit(chunk: UIMessageChunk): void;
  close(): void;
}

function openStream(): OpenStream {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  const stream = new ReadableStream<UIMessageChunk>({
    start(c) {
      controller = c;
    },
  });
  let closed = false;
  return {
    stream,
    get closed() {
      return closed;
    },
    emit(chunk) {
      if (!closed) controller.enqueue(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}

/**
 * The ONLY stubbed seam: the network transport. Every `sendMessages` returns a
 * stream the test holds open, so the test decides exactly when the real `Chat`
 * leaves the busy state. Everything above this boundary — `Chat`, `useChat`,
 * `ChatManager` — runs for real.
 */
class ControllableTransport implements ChatTransport<TestUIMessage> {
  readonly streams: OpenStream[] = [];
  sendCount = 0;
  reconnectCount = 0;

  sendMessages: ChatTransport<TestUIMessage>['sendMessages'] = (options) => {
    this.sendCount++;
    const handle = openStream();
    this.streams.push(handle);
    options.abortSignal?.addEventListener('abort', () => handle.close(), {
      once: true,
    });
    return Promise.resolve(handle.stream);
  };

  reconnectToStream: ChatTransport<TestUIMessage>['reconnectToStream'] = () => {
    this.reconnectCount++;
    return Promise.resolve(null);
  };

  get latest(): OpenStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  /** Push a text chunk so the latest open stream advances 'submitted' → 'streaming'. */
  beginStreaming(id = 'text-0'): void {
    this.latest?.emit({ type: 'text-start', id });
  }

  closeOldestOpen(): void {
    this.streams.find((s) => !s.closed)?.close();
  }

  closeAll(): void {
    for (const handle of [...this.streams]) handle.close();
  }
}

/**
 * Adds the upload capability. Uploads resolve immediately unless the test asks
 * to hold them, in which case it settles each one by hand.
 */
class UploadingTransport extends ControllableTransport {
  readonly uploads: Array<{ sessionId: string; file: File }> = [];
  private readonly holdUploads: boolean;
  private readonly settlers: Array<{
    resolve(receipt: ReturnType<typeof uploadReceipt>): void;
    reject(error: Error): void;
  }> = [];

  constructor(options: { holdUploads?: boolean } = {}) {
    super();
    this.holdUploads = options.holdUploads ?? false;
  }

  uploadFile = (sessionId: string, file: File) => {
    this.uploads.push({ sessionId, file });
    return new Promise<ReturnType<typeof uploadReceipt>>((resolve, reject) => {
      if (this.holdUploads) {
        this.settlers.push({ resolve, reject });
        return;
      }
      resolve(uploadReceipt(sessionId, file));
    });
  };

  completeUpload(index: number): void {
    const { sessionId, file } = this.uploads[index];
    this.settlers[index].resolve(uploadReceipt(sessionId, file));
  }

  failUpload(index: number, error: Error): void {
    this.settlers[index].reject(error);
  }
}

function uploadReceipt(sessionId: string, file: File) {
  return {
    path: `/workspace/.uploads/${sessionId}/${file.name}`,
    name: file.name,
    mediaType: file.type,
    size: file.size,
    url: `https://uploads.test/${sessionId}/${file.name}`,
  };
}

function createManager(options: Omit<ChatManagerOptions, 'uploadFile'>) {
  return new ChatManager({
    ...options,
    uploadFile: async (sessionId, file) => uploadReceipt(sessionId, file),
  });
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, {
    type: 'image/png',
  });
}

/**
 * Replicates the production wiring from `AgentProvider`: bind the live
 * `useChat()` helpers to the manager on every render and forward real status
 * transitions into `manager.syncStatus`, so queue draining happens through the
 * actual status machine rather than by hand-poking the manager.
 */
function renderChatManager(
  manager: ChatManager,
  options: {
    transport: ChatTransport<TestUIMessage>;
    chatId?: string;
    initialMessages?: TestUIMessage[];
  },
) {
  const chat = new Chat<TestUIMessage>({
    ...(options.chatId ? { id: options.chatId } : {}),
    ...(options.initialMessages ? { messages: options.initialMessages } : {}),
    transport: options.transport,
  });
  return renderHook(() => {
    const helpers = useChat<TestUIMessage>({ chat });
    manager.bind(helpers);
    useEffect(() => {
      manager.syncStatus(helpers.status);
    }, [helpers.status]);
    return helpers;
  });
}

function isBusy(status: ChatStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

function textOf(message: TestUIMessage): string | undefined {
  const part = message.parts.find((p) => p.type === 'text');
  return part && part.type === 'text' ? part.text : undefined;
}

function userTexts(messages: readonly TestUIMessage[]): string[] {
  return messages.filter((m) => m.role === 'user').map((m) => textOf(m) ?? '');
}

function plainSubmission(prompt: string): ChatSubmission {
  return { prompt, persistedPrompt: prompt };
}

/**
 * Drive the chat into a busy state through its real public surface by sending a
 * primer message whose response stream stays open.
 */
async function makeBusy(
  manager: ChatManager,
  result: { current: TestChatHelpers },
): Promise<void> {
  await act(async () => {
    manager.submit(plainSubmission('primer'));
  });
  await waitFor(() => {
    expect(isBusy(result.current.status)).toBe(true);
  });
}

describe('ChatManager', () => {
  describe('submission', () => {
    it('submitted message appears in chat', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.submit(plainSubmission('hello'));
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        const [message] = result.current.messages;
        expect(message.role).toBe('user');
        expect(textOf(message)).toBe('hello');
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('submitted message includes metadata', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.submit({
            ...plainSubmission('hello'),
            metadata: { alias: 'test-skill' },
          });
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(result.current.messages[0].metadata).toEqual({
          alias: 'test-skill',
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('marks conversation as started after first submit', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, { transport });
      try {
        expect(manager.hasSubmitted).toBe(false);
        await act(async () => {
          manager.submit(plainSubmission('hello'));
        });
        expect(manager.hasSubmitted).toBe(true);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('submit is a no-op before bind', () => {
      const manager = createManager({ onResetChat: () => {} });
      manager.submit(plainSubmission('hello'));
      expect(manager.hasSubmitted).toBe(false);
    });
  });

  describe('queue', () => {
    it('queues message when chat is busy', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);
        const before = result.current.messages.length;

        await act(async () => {
          manager.submit(plainSubmission('queued'));
        });

        expect(result.current.messages.length).toBe(before);
        expect(manager.queue.length).toBe(1);
        expect(manager.queue[0].persistedPrompt).toBe('queued');
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('sends directly when queue is disabled even if busy', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: false,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);
        const before = result.current.messages.length;

        await act(async () => {
          manager.submit(plainSubmission('direct'));
        });

        await waitFor(() => {
          expect(result.current.messages.length).toBe(before + 1);
        });
        expect(manager.queue.length).toBe(0);
        expect(userTexts(result.current.messages)).toContain('direct');
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('drains first queued message when status transitions to ready', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.submit(plainSubmission('first'));
          manager.submit(plainSubmission('second'));
        });
        expect(manager.queue.length).toBe(2);

        await act(async () => {
          transport.closeOldestOpen();
        });

        expect(manager.queue.length).toBe(1);
        expect(manager.queue[0].persistedPrompt).toBe('second');

        await waitFor(() => {
          expect(userTexts(result.current.messages)).toContain('first');
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('does not drain when status stays busy', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.submit(plainSubmission('queued'));
        });
        expect(manager.queue.length).toBe(1);

        await act(async () => {
          transport.beginStreaming();
        });
        await waitFor(() => {
          expect(result.current.status).toBe('streaming');
        });

        expect(manager.queue.length).toBe(1);
        expect(manager.queue[0].persistedPrompt).toBe('queued');
        expect(userTexts(result.current.messages)).toEqual(['primer']);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('removes specific message from queue by id', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.submit(plainSubmission('a'));
          manager.submit(plainSubmission('b'));
        });
        manager.removeFromQueue(manager.queue[0].id);

        expect(manager.queue.length).toBe(1);
        expect(manager.queue[0].persistedPrompt).toBe('b');
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('clearQueue empties the queue', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.submit(plainSubmission('a'));
          manager.submit(plainSubmission('b'));
        });
        manager.clearQueue();

        expect(manager.queue.length).toBe(0);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('queues persisted source but sends the already-resolved prompt', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.submit({
            prompt: 'List the latest conversations.\n\nfrom today',
            persistedPrompt: '/prompts:recent from today',
            editableSource: {
              persistedPrompt: '/prompts:recent from today',
              remoteImages: [],
              pendingPastes: [],
            },
          });
        });

        expect(manager.queue[0]).toMatchObject({
          prompt: 'List the latest conversations.\n\nfrom today',
          persistedPrompt: '/prompts:recent from today',
          editableSource: {
            persistedPrompt: '/prompts:recent from today',
          },
        });

        await act(async () => {
          transport.closeOldestOpen();
        });
        await waitFor(() => {
          expect(userTexts(result.current.messages)).toContain(
            'List the latest conversations.\n\nfrom today',
          );
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });
  });

  describe('files', () => {
    it('uploads files and sends a text-only message carrying the receipts in metadata', async () => {
      const transport = new UploadingTransport();
      const manager = new ChatManager({
        uploadFile: transport.uploadFile,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, {
        transport,
        chatId: 'chat-files',
      });
      try {
        const file = imageFile();
        await act(async () => {
          await manager.submit({
            ...plainSubmission('describe [Image #1]'),
            metadata: { source: 'composer' },
            files: [file],
          });
        });

        expect(transport.uploads).toHaveLength(1);
        expect(transport.uploads[0].sessionId).toBe('chat-files');
        expect(transport.uploads[0].file).toBe(file);
        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(result.current.messages[0].parts).toEqual([
          { type: 'text', text: 'describe [Image #1]' },
        ]);
        expect(result.current.messages[0].metadata).toEqual({
          source: 'composer',
          uploads: [
            {
              path: '/workspace/.uploads/chat-files/shot.png',
              name: 'shot.png',
              mediaType: 'image/png',
              size: 4,
              url: 'https://uploads.test/chat-files/shot.png',
            },
          ],
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('queued submissions carry the receipts and send them when the chat is ready', async () => {
      const transport = new UploadingTransport();
      const manager = new ChatManager({
        queueEnabled: true,
        uploadFile: transport.uploadFile,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, {
        transport,
        chatId: 'chat-queue',
      });
      const receipt = {
        path: '/workspace/.uploads/chat-queue/later.png',
        name: 'later.png',
        mediaType: 'image/png',
        size: 4,
        url: 'https://uploads.test/chat-queue/later.png',
      };
      try {
        await makeBusy(manager, result);

        await act(async () => {
          await manager.submit({
            ...plainSubmission('later [Image #1]'),
            files: [imageFile('later.png')],
          });
        });

        expect(userTexts(result.current.messages)).toEqual(['primer']);
        expect(manager.queue).toHaveLength(1);
        expect(manager.queue[0].uploads).toEqual([receipt]);

        await act(async () => {
          transport.closeOldestOpen();
        });
        await waitFor(() => {
          expect(userTexts(result.current.messages)).toEqual([
            'primer',
            'later [Image #1]',
          ]);
        });
        const sent = result.current.messages.filter(
          (m) => m.role === 'user',
        )[1];
        expect(sent.parts).toEqual([
          { type: 'text', text: 'later [Image #1]' },
        ]);
        expect(sent.metadata).toEqual({ uploads: [receipt] });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('a text-only submit waits behind a submit that is still uploading', async () => {
      const transport = new UploadingTransport({ holdUploads: true });
      const manager = new ChatManager({
        queueEnabled: true,
        uploadFile: transport.uploadFile,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, {
        transport,
        chatId: 'chat-order',
      });
      try {
        let withImage!: Promise<void>;
        let after!: Promise<void>;
        await act(async () => {
          withImage = manager.submit({
            ...plainSubmission('with image'),
            files: [imageFile()],
          });
          after = manager.submit(plainSubmission('after'));
        });
        await waitFor(() => {
          expect(transport.uploads).toHaveLength(1);
        });
        expect(transport.sendCount).toBe(0);
        expect(manager.queue).toHaveLength(0);

        await act(async () => {
          transport.completeUpload(0);
          await Promise.all([withImage, after]);
        });

        await waitFor(() => {
          expect(userTexts(result.current.messages)).toEqual(['with image']);
        });
        expect(manager.queue.map((m) => m.persistedPrompt)).toEqual(['after']);

        await act(async () => {
          transport.closeOldestOpen();
        });
        await waitFor(() => {
          expect(userTexts(result.current.messages)).toEqual([
            'with image',
            'after',
          ]);
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('a failed upload rejects the submit and sends nothing', async () => {
      const transport = new UploadingTransport({ holdUploads: true });
      const manager = new ChatManager({
        uploadFile: transport.uploadFile,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        let rejection!: Promise<void>;
        await act(async () => {
          rejection = expect(
            manager.submit({
              ...plainSubmission('broken [Image #1]'),
              files: [imageFile()],
            }),
          ).rejects.toThrow('disk full');
        });
        await waitFor(() => {
          expect(transport.uploads).toHaveLength(1);
        });
        await act(async () => {
          transport.failUpload(0, new Error('disk full'));
          await rejection;
        });

        expect(transport.sendCount).toBe(0);
        expect(manager.queue).toHaveLength(0);
        expect(result.current.messages).toEqual([]);
        expect(manager.hasSubmitted).toBe(false);

        await act(async () => {
          await manager.submit(plainSubmission('still works'));
        });
        await waitFor(() => {
          expect(userTexts(result.current.messages)).toEqual(['still works']);
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });
  });

  describe('chat operations', () => {
    it('clearChat empties messages, resets hasSubmitted, and clears queue', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        queueEnabled: true,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);
        await act(async () => {
          manager.submit(plainSubmission('queued'));
        });
        expect(manager.queue.length).toBe(1);

        await act(async () => {
          manager.clearChat();
        });

        await waitFor(() => {
          expect(result.current.messages).toEqual([]);
        });
        expect(manager.hasSubmitted).toBe(false);
        expect(manager.queue.length).toBe(0);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('setChat replaces messages and derives hasSubmitted', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        const messages: TestUIMessage[] = [
          { id: 'u1', role: 'user', parts: [] },
        ];
        await act(async () => {
          manager.setChat(messages);
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(result.current.messages[0].id).toBe('u1');
        expect(manager.hasSubmitted).toBe(true);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('setChat with empty array marks conversation as not started', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        hasSubmitted: true,
        onResetChat: () => {},
      });
      const { unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.setChat([]);
        });

        expect(manager.hasSubmitted).toBe(false);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('stop halts the chat', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await makeBusy(manager, result);

        await act(async () => {
          manager.stop();
        });

        await waitFor(() => {
          expect(result.current.status).toBe('ready');
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });
  });

  describe('reset and prefill', () => {
    it('resetChat generates a new chatId and notifies via callback', () => {
      let receivedChatId: string | undefined;
      const manager = createManager({
        onResetChat: (id) => {
          receivedChatId = id;
        },
      });

      manager.resetChat();

      expect(receivedChatId).toBeTruthy();
      expect(typeof receivedChatId).toBe('string');
      expect((receivedChatId ?? '').length).toBeGreaterThan(0);
    });

    it('resetChat with prompt stores prefill for the new chatId', () => {
      sessionStorage.clear();
      let receivedChatId: string | undefined;
      const manager = createManager({
        onResetChat: (id) => {
          receivedChatId = id;
        },
      });

      manager.resetChat('my prompt');

      const raw = sessionStorage.getItem(PREFILL_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const prefill: PendingPrefill = JSON.parse(raw ?? '');
      expect(prefill.prompt).toBe('my prompt');
      expect(prefill.targetChatId).toBe(receivedChatId);
    });

    it('consumePrefill submits stored prompt when chatId matches', async () => {
      sessionStorage.clear();
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        const chatId = 'target-123';
        writePrefill({ prompt: 'prefilled', targetChatId: chatId });

        await act(async () => {
          manager.consumePrefill(chatId);
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(textOf(result.current.messages[0])).toBe('prefilled');
        expect(sessionStorage.getItem(PREFILL_STORAGE_KEY)).toBeNull();
      } finally {
        unmount();
        transport.closeAll();
        sessionStorage.clear();
      }
    });

    it('consumePrefill ignores stored prompt when chatId does not match', async () => {
      sessionStorage.clear();
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        writePrefill({ prompt: 'prefilled', targetChatId: 'other-id' });

        await act(async () => {
          manager.consumePrefill('my-id');
        });

        expect(result.current.messages).toHaveLength(0);
        expect(sessionStorage.getItem(PREFILL_STORAGE_KEY)).not.toBeNull();
      } finally {
        unmount();
        transport.closeAll();
        sessionStorage.clear();
      }
    });
  });

  describe('message utilities', () => {
    it('finds the user message that triggered a tool call', () => {
      const messages: TestUIMessage[] = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'help' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'help',
              toolCallId: 'tc1',
              state: 'input-available',
              input: {},
            },
          ],
        },
      ];
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, {
        transport,
        initialMessages: messages,
      });
      try {
        const result = manager.getTriggeringUserMessage('tc1');

        expect(result?.id).toBe('u1');
        expect(result?.role).toBe('user');
      } finally {
        unmount();
      }
    });

    it('returns null when no message matches the toolCallId', () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, {
        transport,
        initialMessages: [{ id: 'u1', role: 'user', parts: [] }],
      });
      try {
        expect(manager.getTriggeringUserMessage('nonexistent')).toBeNull();
      } finally {
        unmount();
      }
    });

    it('finds the last user message id', () => {
      const messages: TestUIMessage[] = [
        { id: 'u1', role: 'user', parts: [] },
        { id: 'a1', role: 'assistant', parts: [] },
        { id: 'u2', role: 'user', parts: [] },
        { id: 'a2', role: 'assistant', parts: [] },
      ];
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, {
        transport,
        initialMessages: messages,
      });
      try {
        expect(manager.getLastUserMessageId()).toBe('u2');
      } finally {
        unmount();
      }
    });

    it('returns null when there are no user messages', () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, {
        transport,
        initialMessages: [{ id: 'a1', role: 'assistant', parts: [] }],
      });
      try {
        expect(manager.getLastUserMessageId()).toBeNull();
      } finally {
        unmount();
      }
    });
  });

  describe('meta state and subscription', () => {
    it('notifies listeners when hasSubmitted changes', () => {
      const manager = createManager({ onResetChat: () => {} });
      let notified = false;
      manager.subscribe(() => {
        notified = true;
      });

      manager.hasSubmitted = true;

      expect(notified).toBe(true);
    });

    it('does not notify when hasSubmitted is set to the same value', () => {
      const manager = createManager({
        hasSubmitted: true,
        onResetChat: () => {},
      });
      let notifyCount = 0;
      manager.subscribe(() => {
        notifyCount++;
      });

      manager.hasSubmitted = true;

      expect(notifyCount).toBe(0);
    });

    it('unsubscribed listener stops receiving notifications', () => {
      const manager = createManager({ onResetChat: () => {} });
      let notifyCount = 0;
      const unsubscribe = manager.subscribe(() => {
        notifyCount++;
      });

      manager.hasSubmitted = true;
      expect(notifyCount).toBe(1);

      unsubscribe();
      manager.hasSubmitted = false;
      expect(notifyCount).toBe(1);
    });
  });

  describe('initialize', () => {
    it('is a no-op when chat is not bound', () => {
      const manager = createManager({
        initialMessages: [{ id: 'u1', role: 'user', parts: [] }],
        enableResume: true,
        onResetChat: () => {},
      });

      manager.initialize('some-chat');

      expect(manager.hasSubmitted).toBe(false);
    });

    it('applies initialMessages', async () => {
      const transport = new ControllableTransport();
      const initial: TestUIMessage[] = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ];
      const manager = createManager({
        initialMessages: initial,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.initialize();
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(textOf(result.current.messages[0])).toBe('hi');
        expect(manager.hasSubmitted).toBe(true);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('does not re-apply initialMessages on subsequent calls', async () => {
      const transport = new ControllableTransport();
      const initial: TestUIMessage[] = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ];
      const manager = createManager({
        initialMessages: initial,
        onResetChat: () => {},
      });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.initialize();
        });
        await act(async () => {
          result.current.setMessages([]);
        });

        await act(async () => {
          manager.initialize();
        });

        await waitFor(() => {
          expect(result.current.messages).toEqual([]);
        });
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('calls resumeStream once when enableResume is true', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({
        enableResume: true,
        onResetChat: () => {},
      });
      const { unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.initialize();
        });
        await act(async () => {
          manager.initialize();
        });

        expect(transport.reconnectCount).toBe(1);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('does not call resumeStream when enableResume is false', async () => {
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.initialize();
        });

        expect(transport.reconnectCount).toBe(0);
      } finally {
        unmount();
        transport.closeAll();
      }
    });

    it('consumes prefill matching the passed chatId', async () => {
      sessionStorage.clear();
      const chatId = 'target-abc';
      writePrefill({ prompt: 'auto submit', targetChatId: chatId });
      const transport = new ControllableTransport();
      const manager = createManager({ onResetChat: () => {} });
      const { result, unmount } = renderChatManager(manager, { transport });
      try {
        await act(async () => {
          manager.initialize(chatId);
        });

        await waitFor(() => {
          expect(result.current.messages).toHaveLength(1);
        });
        expect(textOf(result.current.messages[0])).toBe('auto submit');
      } finally {
        unmount();
        transport.closeAll();
        sessionStorage.clear();
      }
    });
  });
});
