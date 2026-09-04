import {
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
  getToolName,
  isToolUIPart,
} from 'ai';

import {
  ContextEngine,
  type ContextStore,
  assistant,
} from '@deepagents/context';

import type { ConversationId } from '../mailbox/types.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import type { ZukhrufToolSet } from '../tool.ts';

export interface ApprovalControllerOptions {
  store: ContextStore;
  queue: TurnQueue;
}

type ApprovalToolPart = DynamicToolUIPart | ToolUIPart;

/** The head assistant message holds a tool call the host has not approved or denied. */
export function hasUnansweredApprovals(message: UIMessage): boolean {
  return message.parts.some(
    (part) => isToolUIPart(part) && part.state === 'approval-requested',
  );
}

/**
 * The head assistant message holds a tool call whose output must come from
 * outside the runtime. Every server-side tool executes before its turn
 * completes, so `input-available` at a completed head is a client tool.
 */
export function hasPendingClientInput(message: UIMessage): boolean {
  return message.parts.some(
    (part) => isToolUIPart(part) && part.state === 'input-available',
  );
}

/** Durable approval-response and continuation state machine. */
export class ApprovalController {
  static readonly #settledToolStates = new Set([
    'output-available',
    'output-error',
    'output-denied',
  ]);

  readonly #store: ContextStore;
  readonly #queue: TurnQueue;

  constructor(options: ApprovalControllerOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
  }

  isPaused(message: UIMessage | undefined): boolean {
    return (
      message?.role === 'assistant' &&
      this.#pendingToolPart(message) !== undefined
    );
  }

  async isConversationPaused(conversation: ConversationId): Promise<boolean> {
    return this.isPaused(
      (await this.#engineFor(conversation).getMessages()).at(-1),
    );
  }

  async settleDeniedApprovals(
    conversation: ConversationId,
    streamId: string,
  ): Promise<void> {
    const engine = this.#engineFor(conversation);
    const head = (await engine.getMessages()).at(-1);
    if (head?.role !== 'assistant' || head.id !== streamId) return;
    const hasDenied = head.parts.some(
      (part) =>
        isToolUIPart(part) &&
        part.state === 'approval-responded' &&
        part.approval.approved === false,
    );
    if (!hasDenied) return;

    const updated: UIMessage = {
      ...head,
      parts: head.parts.map((part) => {
        if (
          !isToolUIPart(part) ||
          part.state !== 'approval-responded' ||
          part.approval.approved !== false
        ) {
          return part;
        }
        const settled: ApprovalToolPart = {
          ...part,
          state: 'output-denied',
          approval: { ...part.approval, approved: false },
        };
        return settled;
      }),
    };
    await engine.continue(assistant(updated));
  }

  async settleFailedApprovals(
    conversation: ConversationId,
    streamId: string,
    error: string,
  ): Promise<void> {
    const engine = this.#engineFor(conversation);
    const head = (await engine.getMessages()).at(-1);
    if (head?.role !== 'assistant' || head.id !== streamId) return;
    const hasResponded = head.parts.some(
      (part) => isToolUIPart(part) && part.state === 'approval-responded',
    );
    if (!hasResponded) return;

    const updated: UIMessage = {
      ...head,
      parts: head.parts.map((part) => {
        if (!isToolUIPart(part) || part.state !== 'approval-responded') {
          return part;
        }
        if (part.approval.approved === false) {
          const denied: ApprovalToolPart = {
            ...part,
            state: 'output-denied',
            approval: { ...part.approval, approved: false },
          };
          return denied;
        }
        const failed: ApprovalToolPart = {
          ...part,
          state: 'output-error',
          errorText: error,
          approval: { ...part.approval, approved: true },
        };
        return failed;
      }),
    };
    await engine.continue(assistant(updated));
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
        error ?? `approval continuation ${status}`,
      );
    }
    await this.#queue.resumeParked(conversation.chatId);
  }

  async retryIdempotentContinuation(
    conversation: ConversationId,
    streamId: string,
    tools: ZukhrufToolSet,
  ): Promise<boolean> {
    const head = (await this.#engineFor(conversation).getMessages()).at(-1);
    if (head?.role !== 'assistant' || head.id !== streamId) return false;
    const approved = head.parts.filter(
      (part): part is ApprovalToolPart =>
        isToolUIPart(part) &&
        part.state === 'approval-responded' &&
        part.approval.approved === true,
    );
    const retryable =
      approved.length > 0 &&
      approved.every((part) => {
        const tool = tools[getToolName(part)];
        return (
          tool?.recovery === 'idempotent' && typeof tool.execute === 'function'
        );
      });
    if (!retryable) return false;

    await this.#queue.push({
      kind: 'recovery',
      streamId,
      chatId: conversation.chatId,
      userId: conversation.userId,
      mode: 'idempotent',
    });
    return true;
  }

  async recoverUnstartedContinuation(
    turn: TurnRef,
    streamId: string,
  ): Promise<boolean> {
    const head = (await this.#engineFor(turn).getMessages()).at(-1);
    if (
      head?.role !== 'assistant' ||
      head.id !== streamId ||
      hasUnansweredApprovals(head) ||
      !head.parts.some(
        (part) => isToolUIPart(part) && part.state === 'approval-responded',
      )
    ) {
      return false;
    }

    await this.#queue.push({
      kind: 'recovery',
      streamId,
      chatId: turn.chatId,
      userId: turn.userId,
      mode: 'handoff',
    });
    return true;
  }

  #pendingToolPart(message: UIMessage) {
    return message.parts.find(
      (part) =>
        isToolUIPart(part) &&
        !ApprovalController.#settledToolStates.has(part.state),
    );
  }

  #engineFor({ chatId, userId }: ConversationId): ContextEngine {
    return new ContextEngine({ store: this.#store, chatId, userId });
  }
}
