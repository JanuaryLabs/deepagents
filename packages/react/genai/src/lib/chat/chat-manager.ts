import type { UIMessage, UseChatHelpers } from '@ai-sdk/react';
import type { ChatStatus, UIDataTypes, UITools } from 'ai';

import type { ComposerDraftSource } from '@deepagents/chat-input/browser';

import { clearPrefill, readPrefill, writePrefill } from './prefill.ts';

export interface ChatSubmission {
  prompt: string;
  persistedPrompt: string;
  editableSource?: ComposerDraftSource;
  metadata?: Record<string, unknown>;
}

export interface QueuedMessage {
  id: string;
  prompt: string;
  persistedPrompt: string;
  editableSource?: ComposerDraftSource;
  metadata?: Record<string, unknown>;
}

type Listener = () => void;

type ChatHelpers = UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>;

export interface ChatManagerOptions {
  queueEnabled?: boolean;
  hasSubmitted?: boolean;
  initialMessages?: UIMessage[];
  enableResume?: boolean;
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

  onResetChat: (chatId: string) => void;

  constructor(options: ChatManagerOptions) {
    this._queueEnabled = options.queueEnabled ?? true;
    this._hasSubmitted = options.hasSubmitted ?? false;
    this._initialMessages = options.initialMessages;
    this._enableResume = options.enableResume ?? false;
    this.onResetChat = options.onResetChat;
  }

  bind(chat: ChatHelpers): void {
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

  submit(submission: ChatSubmission): void {
    if (!this.chat) return;
    if (this._queueEnabled && isBusy(this.chat.status)) {
      this._queue = [
        ...this._queue,
        {
          id: crypto.randomUUID(),
          prompt: submission.prompt,
          persistedPrompt: submission.persistedPrompt,
          editableSource: submission.editableSource,
          metadata: submission.metadata,
        },
      ];
      this.notify();
      return;
    }
    this.directSubmit(submission);
  }

  private directSubmit(submission: ChatSubmission): void {
    if (!this.chat) return;
    this._hasSubmitted = true;
    this.chat.sendMessage({
      role: 'user',
      parts: [{ text: submission.prompt, type: 'text' }],
      metadata: submission.metadata,
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
    this.submit({
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
