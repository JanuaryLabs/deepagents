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

import { approvalJobId } from './approval-job-id.ts';
import type { ConversationId } from './mailbox/types.ts';
import type {
  ApprovalTurnRef,
  TurnQueue,
  TurnRef,
} from './queue/turn-queue.ts';
import type { ZukhrufToolSet } from './tool.ts';

export interface ApprovalControllerOptions {
  store: ContextStore;
  queue: TurnQueue;
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
      kind: 'continuation',
      streamId,
      chatId: conversation.chatId,
      userId: conversation.userId,
      recovery: 'idempotent',
    });
    return true;
  }

  async applyDecision(turn: ApprovalTurnRef): Promise<boolean> {
    const engine = this.#engineFor(turn);
    const head = (await engine.getMessages()).at(-1);
    if (head?.role !== 'assistant' || head.id !== turn.streamId) return false;

    const part = this.#findToolPart(head, turn.toolCallId);
    if (part?.approval?.id !== turn.approvalId) return false;
    if (part.approval.approved !== undefined) return false;
    if (part.state !== 'approval-requested') return false;

    const responded: ApprovalToolPart = {
      ...part,
      state: 'approval-responded',
      approval: { ...part.approval, ...turn.decision },
    };
    const updated: UIMessage = {
      ...head,
      parts: head.parts.map((candidate) =>
        candidate === part ? responded : candidate,
      ),
    };
    await engine.continue(assistant(updated));
    return !this.#hasUnansweredApprovals(updated);
  }

  async recoverUnstartedContinuation(
    turn: TurnRef,
    streamId: string,
  ): Promise<boolean> {
    if (turn.kind === 'approval') await this.applyDecision(turn);
    const head = (await this.#engineFor(turn).getMessages()).at(-1);
    if (
      head?.role !== 'assistant' ||
      head.id !== streamId ||
      this.#hasUnansweredApprovals(head) ||
      !head.parts.some(
        (part) => isToolUIPart(part) && part.state === 'approval-responded',
      )
    ) {
      return false;
    }

    await this.#queue.push({
      kind: 'continuation',
      streamId,
      chatId: turn.chatId,
      userId: turn.userId,
      recovery: 'handoff',
    });
    return true;
  }

  async #respond(
    operation: 'approve' | 'deny',
    conversation: ConversationId,
    toolCallId: string,
    approval: { approved: true } | { approved: false; reason?: string },
  ) {
    const head = (await this.#engineFor(conversation).getMessages()).at(-1);
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
    if (!part.approval) {
      throw new Error(
        `ApprovalController.${operation}: tool call "${toolCallId}" is not awaiting approval`,
      );
    }
    const jobId = approvalJobId(conversation, part.approval.id);
    if (part.approval.approved !== undefined) {
      if (part.approval.approved !== approval.approved) {
        throw new Error(
          `ApprovalController.${operation}: approval already answered with a different decision`,
        );
      }
      return { id: head.id, jobId, status: 'already-applied' as const };
    }
    if (part.state !== 'approval-requested') {
      throw new Error(
        `ApprovalController.${operation}: tool call "${toolCallId}" is not awaiting approval`,
      );
    }

    const result = await this.#queue.push({
      kind: 'approval',
      streamId: head.id,
      chatId: conversation.chatId,
      userId: conversation.userId,
      toolCallId,
      approvalId: part.approval.id,
      decision: approval,
    });
    return {
      id: head.id,
      jobId,
      status: result.inserted
        ? ('queued' as const)
        : ('already-queued' as const),
    };
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
