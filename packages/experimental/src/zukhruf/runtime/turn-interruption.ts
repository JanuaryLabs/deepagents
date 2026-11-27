import { setTimeout as delay } from 'node:timers/promises';

import {
  ContextEngine,
  type StreamManager,
  type StreamStatus,
  user,
} from '@deepagents/context';

import { AgentDirectory } from '../control-plane/agent-directory.ts';
import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import type { AdmissionScope, AgentStorage } from '../storage/agent-storage.ts';
import type { ApprovalController } from './approval-controller.ts';
import { turnAbortedMessage } from './turn-aborted.ts';
import type { TurnSettlement } from './turn-settlement.ts';
import { type UserQuestion, isUserQuestion } from './user-question.ts';

/** How long an interrupt waits for a running turn to exit: Codex's wait_for_thread_shutdown bound. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;
const SHUTDOWN_POLL_INTERVAL_MS = 50;

/**
 * What an interrupt found: a queued turn it ended, recording its question
 * (`recorded`) or not (`dropped`); a turn a worker holds (`running`, or
 * `cancelled` while its worker still writes); or a finished one (`none`).
 */
type Interrupted = 'recorded' | 'dropped' | 'running' | 'cancelled' | 'none';

export interface TurnInterruptionOptions {
  storage: Pick<AgentStorage, 'admit'>;
  streams: StreamManager;
  queue: TurnQueue;
  directory: AgentDirectory;
  approvals: Pick<ApprovalController, 'reconcileUnrunRecovery'>;
  settlement: () => Promise<Pick<TurnSettlement, 'complete'>>;
  publishConversationStatus: (conversation: ConversationId) => Promise<void>;
  /** The declaration a conversation that has no thread yet becomes the root of. */
  rootDeclarationName: string;
}

/**
 * Interrupts a turn as Codex's `handle_task_abort` does, for Stop, turn
 * cancel and archive alike. A lone queued question (Codex's started turn)
 * keeps its input: the question, the `<turn_aborted>` marker and the
 * cancelled stream commit in one admission. A turn queued behind another
 * (Codex's steer) is dropped. A running turn is cancelled and its worker
 * records it on its way out.
 */
export class TurnInterruption {
  readonly #storage: TurnInterruptionOptions['storage'];
  readonly #streams: StreamManager;
  readonly #queue: TurnQueue;
  readonly #directory: AgentDirectory;
  readonly #approvals: TurnInterruptionOptions['approvals'];
  readonly #settlement: TurnInterruptionOptions['settlement'];
  readonly #publish: TurnInterruptionOptions['publishConversationStatus'];
  readonly #rootDeclarationName: string;

  constructor(options: TurnInterruptionOptions) {
    this.#storage = options.storage;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#directory = options.directory;
    this.#approvals = options.approvals;
    this.#settlement = options.settlement;
    this.#publish = options.publishConversationStatus;
    this.#rootDeclarationName = options.rootDeclarationName;
  }

  /**
   * Interrupts `turnId` and resolves once it has exited, waiting at most
   * 10 s for a running one, as Codex answers `turn/interrupt` only on
   * `TurnAborted`.
   */
  async interrupt(conversation: ConversationId, turnId: string): Promise<void> {
    const head = await this.#queue.getCurrentTurn(conversation);
    const interrupted = await this.#interrupt(conversation, turnId, head);
    if (interrupted === 'none') return;
    await this.#awaitTurnExit(
      conversation,
      turnId,
      performance.now() + SHUTDOWN_TIMEOUT_MS,
    );
    await this.#publish(conversation);
  }

  /**
   * Interrupts every queued turn of `member`, then every running one,
   * without waiting for them to exit: archive interrupts a whole tree first
   * and then waits once. The head is read once, so a turn queued behind the
   * head is dropped even after the head is gone.
   */
  async interruptAll(member: ConversationId): Promise<void> {
    const prefix = AgentTurnId.prefixOf(member);
    const head = await this.#queue.getCurrentTurn(member);
    for (const status of ['queued', 'running'] as const) {
      for (const turnId of await this.#streams.store.listStreamIds({
        prefix,
        status,
      })) {
        await this.#interrupt(member, turnId, head);
      }
    }
  }

  /**
   * Ends a queued message turn of an archived tree that a worker found
   * holding its job, which an archive that died before its interrupts left:
   * the worker holds the FIFO job, so the turn is lone and a user's question
   * is recorded. Settling is the worker's.
   */
  async interruptHeld(turn: Extract<TurnRef, { kind: 'message' }>) {
    await this.#admit(
      turn,
      turn.streamId,
      isUserQuestion(turn) ? turn : undefined,
    );
  }

  /** Waits until no member runs a turn, or `deadline` (a `performance.now()` time) passes. */
  async awaitExit(
    members: readonly ConversationId[],
    deadline: number,
  ): Promise<void> {
    for (const member of members) {
      while ((await this.#queue.getTurnActivity(member)) === 'running') {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await delay(Math.min(SHUTDOWN_POLL_INTERVAL_MS, remaining));
      }
    }
  }

  /** Waits until `turnId` is no longer the queue's current turn of the conversation, or `deadline` passes. */
  async #awaitTurnExit(
    conversation: ConversationId,
    turnId: string,
    deadline: number,
  ): Promise<void> {
    while (
      (await this.#queue.getCurrentTurn(conversation))?.streamId === turnId
    ) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await delay(Math.min(SHUTDOWN_POLL_INTERVAL_MS, remaining));
    }
  }

  async #interrupt(
    conversation: ConversationId,
    turnId: string,
    head: TurnRef | undefined,
  ): Promise<Interrupted> {
    const lone =
      head?.streamId === turnId && isUserQuestion(head) ? head : undefined;
    const interrupted = await this.#admit(conversation, turnId, lone);
    if (interrupted === 'none') return interrupted;
    if (interrupted === 'running') await this.#streams.cancel(turnId);
    await this.#queue.cancel(turnId);
    if (interrupted === 'recorded' || interrupted === 'dropped') {
      // A recovery cancelled while queued settles its approval as its run would have.
      await this.#approvals.reconcileUnrunRecovery(
        conversation,
        turnId,
        'cancelled',
      );
    }
    await (
      await this.#settlement()
    ).complete({ ...conversation, streamId: turnId });
    return interrupted;
  }

  /**
   * In one admission: a queued stream moves to cancelled, and when `lone`
   * is its question, the question and the marker are written with it, so
   * every reader sees all three or none. A worker's claim is a CAS on the
   * same row, so only one of them records the input.
   */
  async #admit(
    conversation: ConversationId,
    turnId: string,
    lone: UserQuestion | undefined,
  ): Promise<Interrupted> {
    const thread = await this.#directory.load(conversation);
    const tree = {
      userId: conversation.userId,
      treeId: thread?.treeId ?? conversation.chatId,
    };
    return this.#storage.admit(tree, async (scope) => {
      // A stream that is gone belongs to a deleted chat: nothing to interrupt.
      if ((await scope.streams.getStream(turnId)) === undefined) return 'none';
      const now = Date.now();
      const { stream, updated } = await scope.streams.updateStream(
        turnId,
        ({ status }) =>
          status === 'queued'
            ? { status: 'cancelled', cancelRequestedAt: now, finishedAt: now }
            : undefined,
      );
      if (!updated) return heldOrDone(stream.status);
      if (!lone) return 'dropped';
      await recordQuestion(
        scope,
        conversation,
        lone,
        this.#rootDeclarationName,
      );
      return 'recorded';
    });
  }
}

function heldOrDone(status: StreamStatus): Interrupted {
  return status === 'running' || status === 'cancelled' ? status : 'none';
}

async function recordQuestion(
  scope: AdmissionScope,
  conversation: ConversationId,
  question: UserQuestion,
  rootDeclarationName: string,
): Promise<void> {
  const directory = new AgentDirectory(scope.store);
  if ((await directory.load(conversation)) === undefined) {
    await directory.loadOrCreateRoot(conversation, rootDeclarationName);
  }
  const engine = new ContextEngine({
    store: scope.store,
    chatId: conversation.chatId,
    userId: conversation.userId,
  });
  engine.set(user(question.message), turnAbortedMessage());
  await engine.save({ branch: true });
  await directory.recordLatestTurn(conversation, question.streamId);
}
