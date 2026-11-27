import type { UseChatHelpers } from '@ai-sdk/react';
import { APICallError, SerialJobExecutor, type UIMessage } from 'ai';

import { isRecord } from '@deepagents/context/browser';

import type { AgentUIMessage } from './agent-ui-message.ts';
import { clearPrefill, readPrefill, writePrefill } from './prefill.ts';
import type { ZukhrufChatTransport } from './zukhruf-chat-transport.ts';

type UploadFile = ZukhrufChatTransport['uploadFile'];
type Cancel = ZukhrufChatTransport['cancel'];

export interface ChatSubmission {
  prompt: string;
  persistedPrompt: string;
  metadata?: Record<string, unknown>;
  /** Image files referenced from `prompt`, in `[Image #N]` order. */
  files?: File[];
}

type BoundChat = UseChatHelpers<AgentUIMessage>;

export interface ChatManagerOptions {
  chat: BoundChat;
  uploadFile: UploadFile;
  cancel: Cancel;
  onResetChat: (chatId: string) => void;
}

/**
 * The prompt as the user typed it (`/prompts:recent from today`, a collapsed
 * paste), which `submit` sends in the message's metadata beside the expanded
 * prompt the model reads. Label a queued message with it.
 */
export function persistedPromptOf(message: UIMessage): string {
  const persistedPrompt = isRecord(message.metadata)
    ? message.metadata.persistedPrompt
    : undefined;
  if (typeof persistedPrompt !== 'string') {
    throw new Error(
      `Message ${message.id} has no persistedPrompt: send it with useAgent().submit.`,
    );
  }
  return persistedPrompt;
}

export class ChatManager {
  private chat: BoundChat;
  private readonly uploadFile: UploadFile;
  private readonly cancel: Cancel;
  /**
   * Runs submissions and stops one at a time, in order, so a text-only message
   * never overtakes an image that is uploading, and a question asked after
   * Stop is sent once the server has answered the cancel.
   */
  private readonly submissions = new SerialJobExecutor();

  onResetChat: (chatId: string) => void;

  constructor(options: ChatManagerOptions) {
    this.chat = options.chat;
    this.uploadFile = options.uploadFile;
    this.cancel = options.cancel;
    this.onResetChat = options.onResetChat;
  }

  bind(chat: BoundChat): void {
    this.chat = chat;
  }

  /**
   * Sends the chat's pending prefill once the provider has mounted, and
   * returns the effect's cleanup. React's development StrictMode unmounts
   * right after the first mount, and useChat stops the chat then, which would
   * abort a send already started; the cleanup cancels the deferred send, so
   * the remount sends it once.
   */
  initialize(chatId: string): () => void {
    const unmounted = new AbortController();
    queueMicrotask(() => {
      if (!unmounted.signal.aborted) this.consumePrefill(chatId);
    });
    return () => unmounted.abort();
  }

  /**
   * Resolves once the message is queued or handed to the chat; rejects,
   * sending nothing, when a file cannot be prepared or uploaded.
   */
  submit(submission: ChatSubmission): Promise<void> {
    this.chat.clearError();
    const { files = [], ...message } = submission;
    const chatId = this.chat.id;
    return this.submissions.run(async () => {
      if (files.length === 0) {
        this.assertCurrentChat(chatId);
        this.send(message);
        return;
      }
      const uploads = await this.uploadFiles(chatId, files);
      this.assertCurrentChat(chatId);
      this.send({ ...message, metadata: { ...message.metadata, uploads } });
    });
  }

  private async uploadFiles(chatId: string, files: readonly File[]) {
    return Promise.all(files.map((file) => this.uploadFile(chatId, file)));
  }

  private assertCurrentChat(chatId: string): void {
    if (this.chat.id !== chatId) {
      throw new Error('The chat changed before the submission was sent.');
    }
  }

  /** While a response is in flight the chat queues the message, and sends it once that response finishes. */
  private send({
    id,
    prompt,
    persistedPrompt,
    metadata,
  }: Omit<ChatSubmission, 'files'> & { id?: string }): void {
    void this.chat.sendMessage({
      id,
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      metadata: { ...metadata, persistedPrompt },
    });
  }

  clearChat(): void {
    for (const { id } of this.chat.experimental_queuedMessages) {
      this.chat.experimental_removeQueuedMessage(id);
    }
    this.chat.setMessages([]);
  }

  setChat(messages: AgentUIMessage[]): void {
    this.chat.setMessages(messages);
  }

  /**
   * Stops the answer's stream at once and asks the server to cancel the turn;
   * resolves once it answers. Rejects when the cancel fails: the turn may
   * still run. When the server refuses the cancel, the chat resumes the turn's
   * stream, so the answer keeps arriving, and later submissions wait for that
   * turn to end. A prefill still pending is cleared: the user chose not to
   * send it.
   */
  stop(): Promise<void> {
    const prefill = readPrefill();
    if (
      prefill &&
      this.chat.messages.some((message) => message.id === prefill.messageId)
    ) {
      clearPrefill();
    }
    const chatId = this.chat.id;
    const cancelled = Promise.withResolvers<void>();
    void this.submissions.run(async () => {
      const [stopped, cancel] = await Promise.allSettled([
        this.chat.stop(),
        this.cancel(chatId),
      ]);
      if (stopped.status === 'rejected') {
        cancelled.reject(stopped.reason);
        return;
      }
      if (cancel.status === 'fulfilled') {
        cancelled.resolve();
        return;
      }
      cancelled.reject(cancel.reason);
      if (APICallError.isInstance(cancel.reason)) {
        await this.chat.resumeStream();
      }
    });
    return cancelled.promise;
  }

  /**
   * Resolves once every stop and submission asked so far has run, the turn a
   * refused cancel resumed included.
   */
  settled(): Promise<void> {
    return this.submissions.run(async () => {});
  }

  resetChat(prompt?: string): void {
    const nextChatId = crypto.randomUUID();
    if (prompt) {
      writePrefill({ prompt, targetChatId: nextChatId });
    }
    this.onResetChat(nextChatId);
  }

  /**
   * Sends the chat's pending prefill under its own message id, with its
   * uploads' receipts in `metadata.uploads` as `submit` sends them. The
   * transport AgentProvider wraps clears it once a turn holding that message
   * is accepted, so a send that fails leaves it, receipts included, for the
   * chat's next mount, and no file is uploaded again.
   */
  consumePrefill(chatId: string): void {
    const prefill = readPrefill();
    if (!prefill || prefill.targetChatId !== chatId) return;
    const currentChatId = this.chat.id;
    const { messageId, prompt, uploads } = prefill;
    void this.submissions.run(async () => {
      this.assertCurrentChat(currentChatId);
      this.send({
        id: messageId,
        prompt,
        persistedPrompt: prompt,
        metadata: uploads.length > 0 ? { uploads } : undefined,
      });
    });
  }

  getTriggeringUserMessage(toolCallId: string): AgentUIMessage | null {
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
    const { messages } = this.chat;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }

  getLastAssistantMessage(): AgentUIMessage | null {
    const { messages } = this.chat;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i];
    }
    return null;
  }

  /** Whether the bound chat has messages: the conversation has started. */
  get hasSubmitted(): boolean {
    return this.chat.messages.length > 0;
  }
}
