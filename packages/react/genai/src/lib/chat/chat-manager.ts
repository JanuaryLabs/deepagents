import type { Chat, UIMessage } from '@ai-sdk/react';
import {
  type ChatStatus,
  SerialJobExecutor,
  type UIDataTypes,
  type UITools,
} from 'ai';

import type { ComposerDraftSource } from '@deepagents/react-input/browser';

import { clearPrefill, readPrefill, writePrefill } from './prefill.ts';
import type { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

type UploadFile = ZukhrufChatTransport['uploadFile'];

export interface ChatSubmission {
  prompt: string;
  persistedPrompt: string;
  editableSource?: ComposerDraftSource;
  metadata?: Record<string, unknown>;
  /** Image files referenced from `prompt`, in `[Image #N]` order. */
  files?: File[];
}

export interface QueuedMessage {
  id: string;
  prompt: string;
  persistedPrompt: string;
  editableSource?: ComposerDraftSource;
  metadata?: Record<string, unknown>;
  /** Receipts for the submission's files, in `[Image #N]` order; sent as `metadata.uploads`. */
  uploads?: Awaited<ReturnType<UploadFile>>[];
}

type PreparedSubmission = Omit<QueuedMessage, 'id'>;

type Listener = () => void;

type BoundChat = Chat<UIMessage<unknown, UIDataTypes, UITools>>;

export interface ChatManagerOptions {
  queueEnabled?: boolean;
  uploadFile: UploadFile;
  onResetChat: (chatId: string) => void;
}

function isBusy(status: ChatStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

export class ChatManager {
  private chat: BoundChat | null = null;
  private prevStatus: ChatStatus = 'ready';
  private listeners = new Set<Listener>();
  private _queue: QueuedMessage[] = [];
  private _queueEnabled: boolean;
  private readonly uploadFile: UploadFile;
  /**
   * Runs submissions one at a time, in order, so a text-only message never
   * overtakes an image that is uploading. An idle executor starts a job at
   * once, so a submission without files still dispatches synchronously.
   */
  private readonly submissions = new SerialJobExecutor();

  onResetChat: (chatId: string) => void;

  constructor(options: ChatManagerOptions) {
    this._queueEnabled = options.queueEnabled ?? true;
    this.uploadFile = options.uploadFile;
    this.onResetChat = options.onResetChat;
  }

  bind(chat: BoundChat): void {
    this.chat = chat;
  }

  syncStatus(status: ChatStatus): void {
    const prev = this.prevStatus;
    this.prevStatus = status;
    if (isBusy(prev) && status === 'ready') {
      this.processQueue();
    }
  }

  initialize(chatId?: string): void {
    if (!this.chat) return;
    if (chatId) this.consumePrefill(chatId);
  }

  /**
   * Resolves once the message is queued or handed to the chat. Submissions
   * without files keep the synchronous path; rejects, sending nothing, when a
   * file cannot be prepared or uploaded.
   */
  submit(submission: ChatSubmission): Promise<void> {
    if (!this.chat) return Promise.resolve();
    const { files = [], ...message } = submission;
    const chatId = this.chat.id;
    return this.submissions.run(async () => {
      if (files.length === 0) {
        this.assertCurrentChat(chatId);
        this.dispatch(message);
        return;
      }
      const uploads = await this.uploadFiles(chatId, files);
      this.assertCurrentChat(chatId);
      this.dispatch({ ...message, uploads });
    });
  }

  private async uploadFiles(chatId: string, files: readonly File[]) {
    return Promise.all(files.map((file) => this.uploadFile(chatId, file)));
  }

  private assertCurrentChat(chatId: string): void {
    if (this.chat?.id !== chatId) {
      throw new Error('The chat changed before the submission was sent.');
    }
  }

  private dispatch(message: PreparedSubmission): void {
    if (!this.chat) return;
    if (this._queueEnabled && this.isChatBusy()) {
      this._queue = [...this._queue, { id: crypto.randomUUID(), ...message }];
      this.notify();
      return;
    }
    this.directSubmit(message);
  }

  /** Reads the live Chat, which reports `submitted` as soon as a send starts. */
  private isChatBusy(): boolean {
    return this.chat !== null && isBusy(this.chat.status);
  }

  private directSubmit(message: PreparedSubmission): void {
    if (!this.chat) return;
    void this.chat.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: message.prompt }],
      metadata: message.uploads
        ? { ...message.metadata, uploads: message.uploads }
        : message.metadata,
    });
    this.notify();
  }

  private processQueue(): void {
    if (!this._queueEnabled || this._queue.length === 0) return;
    const [next, ...rest] = this._queue;
    this._queue = rest;
    this.notify();
    queueMicrotask(() => this.directSubmit(next));
  }

  removeFromQueue(id: string): void {
    const next = this._queue.filter((msg) => msg.id !== id);
    if (next.length === this._queue.length) return;
    this._queue = next;
    this.notify();
  }

  clearQueue(): void {
    if (this._queue.length === 0) return;
    this._queue = [];
    this.notify();
  }

  get queue(): readonly QueuedMessage[] {
    return this._queue;
  }

  get queueEnabled(): boolean {
    return this._queueEnabled;
  }

  clearChat(): void {
    if (!this.chat) return;
    this.chat.messages = [];
    this.clearQueue();
    this.notify();
  }

  setChat(messages: UIMessage[]): void {
    if (!this.chat) return;
    this.chat.messages = messages;
    this.notify();
  }

  stop(): void {
    if (!this.chat) return;
    void this.chat.stop();
  }

  resetChat(prompt?: string): void {
    const nextChatId = crypto.randomUUID();
    if (prompt) {
      writePrefill({ prompt, targetChatId: nextChatId });
    }
    this.onResetChat(nextChatId);
  }

  consumePrefill(chatId: string): void {
    const prefill = readPrefill();
    if (!prefill || prefill.targetChatId !== chatId) return;
    clearPrefill();
    void this.submit({
      prompt: prefill.prompt,
      persistedPrompt: prefill.prompt,
    });
  }

  getTriggeringUserMessage(toolCallId: string): UIMessage | null {
    if (!this.chat) return null;
    const { messages } = this.chat;
    const idx = messages.findIndex(
      (msg) =>
        msg.role === 'assistant' &&
        msg.parts.some((p) => 'toolCallId' in p && p.toolCallId === toolCallId),
    );
    if (idx <= 0) return null;
    const userMsg = messages[idx - 1];
    return userMsg?.role === 'user' ? userMsg : null;
  }

  getLastUserMessageId(): string | null {
    if (!this.chat) return null;
    const { messages } = this.chat;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }

  getLastAssistantMessage(): UIMessage | null {
    if (!this.chat) return null;
    const { messages } = this.chat;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i];
    }
    return null;
  }

  /** Whether the bound chat has messages: the conversation has started. */
  get hasSubmitted(): boolean {
    return (this.chat?.messages.length ?? 0) > 0;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
