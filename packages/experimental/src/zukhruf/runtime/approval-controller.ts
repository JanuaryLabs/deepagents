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

import type { AgentResidency } from '../control-plane/agent-residency.ts';
import { AgentThreadLimitError } from '../control-plane/agent-thread-limit-error.ts';
import type { ConversationId } from '../mailbox/types.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import type { ZukhrufToolSet } from '../tool.ts';

export interface ApprovalControllerOptions {
  store: ContextStore;
  queue: TurnQueue;
  residency: AgentResidency;
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
 * outside the runtime. A turn writes its assistant message at each step's
 * end, after the step's server-side tools executed, so `input-available` at
 * a head whose turn is not running is a client tool.
 */
export function hasPendingClientInput(message: UIMessage): boolean {
  return message.parts.some(
    (part) => isToolUIPart(part) && part.state === 'input-available',
  );
}

const SETTLED_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
]);

/** The head is an assistant message with a tool call that has not settled: it waits on the host or a client. */
export function isPausedHead(message: UIMessage | undefined): boolean {
  return (
    message?.role === 'assistant' &&
    message.parts.some(
      (part) => isToolUIPart(part) && !SETTLED_TOOL_STATES.has(part.state),
    )
  );
}

/** Durable approval-response and continuation state machine. */
export class ApprovalController {
  readonly #store: ContextStore;
  readonly #queue: TurnQueue;
  readonly #residency: AgentResidency;

  constructor(options: ApprovalControllerOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#residency = options.residency;
  }

  isPaused(message: UIMessage | undefined): boolean {
    return isPausedHead(message);
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

  /**
   * Settles a recovery that will never run: its job was lost or withdrawn
   * while the head still records the approval answer it was to act on. A
   * head without a recorded answer, as a lost or cancelled continuation
   * leaves, keeps waiting for the answer instead.
   */
  async reconcileUnrunRecovery(
    conversation: ConversationId,
    streamId: string,
    status: 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    const head = (await this.#engineFor(conversation).getMessages()).at(-1);
    if (
      head?.role !== 'assistant' ||
      head.id !== streamId ||
      !head.parts.some(
        (part) => isToolUIPart(part) && part.state === 'approval-responded',
      )
    ) {
      return;
    }
    await this.reconcileTerminalContinuation(
      conversation,
      streamId,
      status,
      error,
    );
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

    await this.#pushRecovery({
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

    await this.#pushRecovery({
      kind: 'recovery',
      streamId,
      chatId: turn.chatId,
      userId: turn.userId,
      mode: 'handoff',
    });
    return true;
  }

  /**
   * A head with a responded approval has not settled, so its conversation is
   * resident and holds its own slot: the recovery is admitted at the limit.
   * The push queues the terminal stream it re-executes, as every admission
   * queues its turn's stream with its job, so a recovery whose job is lost
   * is a queued stream the lost-turn sweep fails.
   */
  #pushRecovery(turn: TurnRef & { kind: 'recovery' }): Promise<void> {
    return this.#residency.admit(turn, async (admission) => {
      if (!(await admission.admits(turn))) throw new AgentThreadLimitError();
      await admission.streams.reopenStream(turn.streamId);
      await admission.queue.push(turn);
    });
  }

  #engineFor({ chatId, userId }: ConversationId): ContextEngine {
    return new ContextEngine({ store: this.#store, chatId, userId });
  }
}
