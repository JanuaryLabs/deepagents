import type { UIMessage, UseChatHelpers } from '@ai-sdk/react';
import type { ChatStatus, UIDataTypes, UITools } from 'ai';

import type { ComposerDraftSource } from '@deepagents/react-input/browser';

import { clearPrefill, readPrefill, writePrefill } from './prefill.ts';
import { prepareImageFile } from './prepare-image.ts';
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

type ChatHelpers = UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>;

export interface ChatManagerOptions {
  queueEnabled?: boolean;
  hasSubmitted?: boolean;
  initialMessages?: UIMessage[];
  enableResume?: boolean;
  uploadFile: UploadFile;
  onResetChat: (chatId: string) => void;
}

function isBusy(status: ChatStatus): boolean {
  return status === 'streaming' || status === 'submitted';
}

export class ChatManager {
  private chat: ChatHelpers | null = null;
  private prevStatus: ChatStatus = 'ready';
  private listeners = new Set<Listener>();
  private _queue: QueuedMessage[] = [];
  private _queueEnabled: boolean;
  private _hasSubmitted: boolean;
  private _initialMessages?: UIMessage[];
  private _initialMessagesApplied = false;
  private _enableResume: boolean;
  private _resumed = false;
  private readonly uploadFile: UploadFile;
  /**
   * Submissions still preparing their files, in order. Later submissions chain
   * behind it so a text-only message never overtakes an image that is
   * uploading; `null` once nothing is in flight.
   */
  private pendingSubmissions: Promise<void> | null = null;
  /**
   * `sendMessage` ran but the bound helpers still report the pre-send status
   * (they are a render snapshot), so treat the chat as busy until the next
   * status sync.
   */
  private sentAwaitingStatus = false;

  onResetChat: (chatId: string) => void;

  constructor(options: ChatManagerOptions) {
    this._queueEnabled = options.queueEnabled ?? true;
    this._hasSubmitted = options.hasSubmitted ?? false;
    this._initialMessages = options.initialMessages;
    this._enableResume = options.enableResume ?? false;
    this.uploadFile = options.uploadFile;
    this.onResetChat = options.onResetChat;
  }

  bind(chat: ChatHelpers): void {
    this.chat = chat;
  }

  syncStatus(status: ChatStatus): void {
    this.sentAwaitingStatus = false;
    const prev = this.prevStatus;
    this.prevStatus = status;
    if (isBusy(prev) && status === 'ready') {
      this.processQueue();
    }
  }

  initialize(chatId?: string): void {
    if (!this.chat) return;

    if (!this._initialMessagesApplied) {
      if (
        this._initialMessages &&
        this._initialMessages.length > 0 &&
        this.chat.messages.length === 0
      ) {
        this.chat.setMessages(this._initialMessages);
        this._hasSubmitted = true;
        this.notify();
      }
      this._initialMessagesApplied = true;
    }

    if (this._enableResume && !this._resumed) {
      this.chat.resumeStream();
      this._resumed = true;
    }

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
    if (files.length === 0 && !this.pendingSubmissions) {
      this.dispatch(message);
      return Promise.resolve();
    }
    const chatId = this.chat.id;
    const current = (this.pendingSubmissions ?? Promise.resolve()).then(
      async () => {
        if (files.length === 0) {
          this.dispatch(message);
          return;
        }
        const uploads = await this.uploadFiles(chatId, files);
        this.dispatch({ ...message, uploads });
      },
    );
    const settled: Promise<void> = current
      .catch(() => undefined)
      .then(() => {
        if (this.pendingSubmissions === settled) this.pendingSubmissions = null;
      });
    this.pendingSubmissions = settled;
    return current;
  }

  private async uploadFiles(chatId: string, files: readonly File[]) {
    return Promise.all(
      files.map(async (file) =>
        this.uploadFile(chatId, await prepareImageFile(file)),
      ),
    );
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

  private isChatBusy(): boolean {
    return (
      this.sentAwaitingStatus ||
      (this.chat !== null && isBusy(this.chat.status))
    );
  }

  private directSubmit(message: PreparedSubmission): void {
    if (!this.chat) return;
    this._hasSubmitted = true;
    this.sentAwaitingStatus = true;
    this.chat.sendMessage({
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
    this.chat.setMessages([]);
    this._hasSubmitted = false;
    this.clearQueue();
    this.notify();
  }

  setChat(messages: UIMessage[]): void {
    if (!this.chat) return;
    this.chat.setMessages(messages);
    this._hasSubmitted = messages.length > 0;
    this.notify();
  }

  stop(): void {
    if (!this.chat) return;
    this.chat.stop();
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

  get hasSubmitted(): boolean {
    return this._hasSubmitted;
  }

  set hasSubmitted(value: boolean) {
    if (this._hasSubmitted === value) return;
    this._hasSubmitted = value;
    this.notify();
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
