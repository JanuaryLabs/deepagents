import {
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
  isToolUIPart,
} from 'ai';

import {
  ContextEngine,
  type ContextStore,
  type StreamManager,
  assistant,
} from '@deepagents/context';

import type { ApprovalMutex } from './approval-mutex.ts';
import type { ConversationId } from './mailbox/types.ts';
import type { TurnQueue } from './queue/turn-queue.ts';

export interface ApprovalControllerOptions {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  mutex: ApprovalMutex;
}

type ApprovalToolPart = DynamicToolUIPart | ToolUIPart;

/** Durable approval-response and continuation state machine. */
export class ApprovalController {
  static readonly #settledToolStates = new Set([
    'output-available',
    'output-error',
    'output-denied',
  ]);

  readonly #store: ContextStore;
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #mutex: ApprovalMutex;

  constructor(options: ApprovalControllerOptions) {
    this.#store = options.store;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#mutex = options.mutex;
  }

  isPaused(message: UIMessage | undefined): boolean {
    return (
      message?.role === 'assistant' &&
      this.#pendingToolPart(message) !== undefined
    );
  }

  approve(conversation: ConversationId, input: { toolCallId: string }) {
    return this.#respond('approve', conversation, input.toolCallId, {
      approved: true,
    });
  }

  deny(
    conversation: ConversationId,
    input: { toolCallId: string; reason?: string },
  ) {
    return this.#respond('deny', conversation, input.toolCallId, {
      approved: false,
      reason: input.reason,
    });
  }

  async settleDeniedApprovals(
    conversation: ConversationId,
    streamId: string,
  ): Promise<void> {
    await this.#mutex.runExclusive(conversation.chatId, async () => {
      const engine = this.#engineFor(conversation);
      const head = (await engine.getMessages()).at(-1);
      if (head?.role !== 'assistant' || head.id !== streamId) return;
      const denied = head.parts.filter(
        (part) =>
          isToolUIPart(part) &&
          part.state === 'approval-responded' &&
          part.approval.approved === false,
      );
      if (denied.length === 0) return;

      const updated = {
        ...head,
        parts: head.parts.map((part) =>
          denied.includes(part as ApprovalToolPart)
            ? { ...part, state: 'output-denied' }
            : part,
        ),
      } as UIMessage;
      await engine.continue(assistant(updated));
    });
  }

  async settleFailedApprovals(
    conversation: ConversationId,
    streamId: string,
    error: string,
  ): Promise<void> {
    await this.#mutex.runExclusive(conversation.chatId, async () => {
      const engine = this.#engineFor(conversation);
      const head = (await engine.getMessages()).at(-1);
      if (head?.role !== 'assistant' || head.id !== streamId) return;
      const responded = head.parts.filter(
        (part) => isToolUIPart(part) && part.state === 'approval-responded',
      );
      if (responded.length === 0) return;

      const updated = {
        ...head,
        parts: head.parts.map((part) =>
          isToolUIPart(part) && part.state === 'approval-responded'
            ? part.approval.approved === false
              ? { ...part, state: 'output-denied' }
              : { ...part, state: 'output-error', errorText: error }
            : part,
        ),
      } as UIMessage;
      await engine.continue(assistant(updated));
    });
  }

  async reconcileTerminalContinuation(
    conversation: ConversationId,
    streamId: string,
    status: 'completed' | 'failed' | 'cancelled',
    error?: string | null,
  ): Promise<void> {
    if (status === 'completed') {
      await this.settleDeniedApprovals(conversation, streamId);
    } else {
      await this.settleFailedApprovals(
        conversation,
        streamId,
        error ??
          (status === 'cancelled'
            ? 'approval continuation cancelled'
            : 'approval continuation failed'),
      );
    }
    await this.#queue.resumeParked(conversation.chatId);
  }

  async #respond(
    operation: 'approve' | 'deny',
    conversation: ConversationId,
    toolCallId: string,
    approval: { approved: true } | { approved: false; reason?: string },
  ) {
    const result = await this.#mutex.runExclusive(
      conversation.chatId,
      async () => {
        const engine = this.#engineFor(conversation);
        const head = (await engine.getMessages()).at(-1);
        if (head?.role !== 'assistant') {
          throw new Error(
            `ApprovalController.${operation}: no paused turn — the chain head is not an assistant message`,
          );
        }
        const part = this.#findToolPart(head, toolCallId);
        if (!part) {
          throw new Error(
            `ApprovalController.${operation}: no tool call "${toolCallId}" on the paused turn`,
          );
        }
        if (
          part.approval?.approved !== undefined &&
          part.approval.approved !== approval.approved
        ) {
          throw new Error(
            `ApprovalController.${operation}: approval already answered with a different decision`,
          );
        }

        let updated = head;
        let answered = part;
        if (part.state === 'approval-requested') {
          const responded = {
            ...part,
            state: 'approval-responded',
            approval: { ...part.approval, ...approval },
          } as ApprovalToolPart;
          updated = {
            ...head,
            parts: head.parts.map((candidate) =>
              candidate === part ? responded : candidate,
            ),
          } as UIMessage;
          await engine.continue(assistant(updated));
          answered = responded;
        }

        return {
          id: updated.id,
          hasUnansweredApprovals: this.#hasUnansweredApprovals(updated),
          shouldSchedule: answered.state === 'approval-responded',
        };
      },
    );

    if (!result.hasUnansweredApprovals) {
      if (result.shouldSchedule) {
        await this.#scheduleContinuation(conversation, result.id);
      } else {
        // A retry after the continuation settled is also the reconciliation
        // path for a crash between queueing that continuation and reviving the
        // older turns it had parked.
        await this.#queue.resumeParked(conversation.chatId);
      }
    }
    return { id: result.id, stream: this.#streams.watch(result.id) };
  }

  async #scheduleContinuation(
    conversation: ConversationId,
    streamId: string,
  ): Promise<void> {
    let status = await this.#streams.store.getStreamStatus(streamId);
    if (status === 'completed') {
      try {
        await this.#streams.reopen(streamId);
        status = 'queued';
      } catch (error) {
        status = await this.#streams.store.getStreamStatus(streamId);
        if (status !== 'queued' && status !== 'running') throw error;
      }
    } else if (status !== 'queued' && status !== 'running') {
      return;
    }

    if (status !== 'running') {
      await this.#queue.push({
        kind: 'continuation',
        streamId,
        chatId: conversation.chatId,
        userId: conversation.userId,
      });
    }
    await this.#queue.resumeParked(conversation.chatId);
  }

  #pendingToolPart(message: UIMessage) {
    return message.parts.find(
      (part) =>
        isToolUIPart(part) &&
        !ApprovalController.#settledToolStates.has(part.state),
    );
  }

  #hasUnansweredApprovals(message: UIMessage): boolean {
    return message.parts.some(
      (part) => isToolUIPart(part) && part.state === 'approval-requested',
    );
  }

  #findToolPart(
    message: UIMessage,
    toolCallId: string,
  ): ApprovalToolPart | undefined {
    return message.parts.find(
      (part): part is ApprovalToolPart =>
        isToolUIPart(part) && part.toolCallId === toolCallId,
    );
  }

  #engineFor({ chatId, userId }: ConversationId): ContextEngine {
    return new ContextEngine({ store: this.#store, chatId, userId });
  }
}
