import { type UIMessage, isTextUIPart } from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  type StreamStatus,
} from '@deepagents/context';

import type { AgentDirectory } from './agent-directory.ts';
import type { AgentThread } from './agent-thread.ts';
import type { ApprovalController } from './approval-controller.ts';
import type { MailboxCoordinator } from './mailbox/coordinator.ts';
import {
  InterAgentCommunicationType,
  MessageDeliveryMode,
  createInterAgentCommunication,
} from './mailbox/types.ts';
import type { TurnQueue, TurnRef } from './queue/turn-queue.ts';

export type ListedAgentStatus =
  | 'pending_init'
  | 'running'
  | 'waiting_approval'
  | 'interrupted'
  | { completed: string | null }
  | { errored: string };

export interface ListedAgent {
  agent_name: string;
  agent_status: ListedAgentStatus;
  last_task_message: string | null;
}

export interface AgentStatusProjectorOptions {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  mailbox: MailboxCoordinator;
  directory: AgentDirectory;
  approvals: ApprovalController;
}

/** Projects durable execution state into agent-facing status and terminal mail. */
export class AgentStatusProjector {
  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #mailbox: MailboxCoordinator;
  readonly #directory: AgentDirectory;
  readonly #approvals: ApprovalController;

  constructor(options: AgentStatusProjectorOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#mailbox = options.mailbox;
    this.#directory = options.directory;
    this.#approvals = options.approvals;
  }

  async projectListedAgent(
    currentTurn: TurnRef,
    thread: AgentThread,
  ): Promise<ListedAgent> {
    const messages = await this.#messages(thread);
    const head = messages.at(-1);
    const streamId =
      thread.lastTurnId ?? (head?.role === 'assistant' ? head.id : undefined);
    const stream = streamId
      ? await this.#streams.store.getStream(streamId)
      : undefined;
    const activity = await this.#queue.getTurnActivity(thread.conversation);
    const scheduledTurn =
      activity === 'idle'
        ? undefined
        : await this.#queue.getCurrentTurn(thread.conversation);
    const scheduledStream = scheduledTurn
      ? await this.#streams.store.getStream(scheduledTurn.streamId)
      : undefined;
    let status = AgentStatusProjector.#listedStatus(
      stream?.status,
      stream?.error,
      head,
    );
    if (stream?.status === 'completed' && this.#approvals.isPaused(head)) {
      status = 'waiting_approval';
    }
    if (
      thread.conversation.chatId === currentTurn.chatId ||
      (thread.lastTurnId !== undefined &&
        scheduledTurn?.streamId !== thread.lastTurnId &&
        (scheduledStream?.status === 'queued' ||
          scheduledStream?.status === 'running'))
    ) {
      status = 'running';
    }

    return {
      agent_name: thread.path.toString(),
      agent_status: status,
      last_task_message: thread.path.isRoot
        ? 'Main thread'
        : AgentStatusProjector.#lastUserMessage(messages),
    };
  }

  async projectTerminal(turn: TurnRef, thread: AgentThread): Promise<void> {
    if (thread.parentChatId === null) return;
    const stream = await this.#streams.store.getStream(turn.streamId);
    if (
      !stream ||
      (stream.status !== 'completed' &&
        stream.status !== 'failed' &&
        stream.status !== 'cancelled')
    ) {
      return;
    }

    const message = (await this.#messages(thread)).find(
      (candidate) =>
        candidate.role === 'assistant' && candidate.id === turn.streamId,
    );
    if (stream.status === 'completed' && this.#approvals.isPaused(message)) {
      return;
    }
    const text =
      message?.role === 'assistant'
        ? AgentStatusProjector.#messageText(message)
        : '';
    const content =
      stream.status === 'failed'
        ? `Agent failed: ${stream.error || 'unknown error'}`
        : stream.status === 'cancelled'
          ? 'Agent was interrupted.'
          : text || 'Agent completed without a text response.';
    const parent = await this.#directory.load({
      chatId: thread.parentChatId,
      userId: thread.conversation.userId,
    });

    await this.#mailbox.deliver(
      createInterAgentCommunication({
        id: `zukhruf:child-terminal:${turn.streamId}`,
        type: InterAgentCommunicationType.FinalAnswer,
        author: thread.conversation,
        recipient: {
          chatId: thread.parentChatId,
          userId: thread.conversation.userId,
        },
        content,
        metadata: {
          authorPath: thread.path.toString(),
          recipientPath: parent?.path.toString() ?? thread.parentChatId,
          streamId: turn.streamId,
          status: stream.status,
        },
      }),
      MessageDeliveryMode.QueueOnly,
    );
  }

  async #messages(thread: AgentThread): Promise<UIMessage[]> {
    const engine = new ContextEngine({
      store: this.#store,
      chatId: thread.conversation.chatId,
      userId: thread.conversation.userId,
    });
    return engine.getMessages();
  }

  static #listedStatus(
    status: StreamStatus | undefined,
    error: string | null | undefined,
    head: UIMessage | undefined,
  ): ListedAgentStatus {
    switch (status) {
      case 'running':
        return 'running';
      case 'completed':
        return {
          completed:
            head?.role === 'assistant'
              ? AgentStatusProjector.#messageText(head) || null
              : null,
        };
      case 'failed':
        return { errored: error || 'Agent turn failed.' };
      case 'cancelled':
        return 'interrupted';
      case 'queued':
      case undefined:
        return 'pending_init';
    }
  }

  static #lastUserMessage(messages: UIMessage[]): string | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role === 'user') {
        return AgentStatusProjector.#messageText(message) || null;
      }
    }
    return null;
  }

  static #messageText(message: UIMessage): string {
    return message.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join('\n')
      .trim();
  }
}
