import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

import type { StreamStatus, StreamStore } from '@deepagents/context';

import type { AgentDirectory } from '../control-plane/agent-directory.ts';
import type { AgentThread } from '../control-plane/agent-thread.ts';
import { conversationNamespace } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';
import { isNonRetryableError } from '../non-retryable-error.ts';
import type { SettleIntent, SettleQueue } from '../queue/settle-intent.ts';
import type { TurnQueue, TurnRef } from '../queue/turn-queue.ts';
import type { AdmissionScope, AgentStorage } from '../storage/agent-storage.ts';

/**
 * Work owed to a conversation once one of its turns has settled, such as
 * arming its sandbox's idle stop. It runs from a durable intent, at least
 * once, on any process that has it, so it must be idempotent and safe to run
 * concurrently with itself on another host. A failure is retried, unless it
 * is a NonRetryableError.
 */
export interface SettleFollowUp {
  /** Names the follow-up's own intent queue. */
  readonly name: string;
  run(conversation: ConversationId): Promise<void>;
}

const settleIntentSchema: z.ZodType<SettleIntent> = z
  .object({
    conversation: z
      .object({ chatId: z.string().min(1), userId: z.string().min(1) })
      .strict(),
    turnId: z.string().min(1),
  })
  .strict();

/** A settle follow-up failed in a way no retry changes (a NonRetryableError); its intent is done. */
class SettleFollowUpWarning extends Error {
  readonly code = 'DEEPAGENTS_ZUKHRUF_SETTLE_FOLLOW_UP_FAILED';
  readonly detail: string;

  constructor(
    failure: unknown,
    followUp: string,
    conversation: ConversationId,
    turnId: string,
  ) {
    super(
      `Settle follow-up "${followUp}" failed and will not be retried: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'SettleFollowUpWarning';
    this.detail = `chat: ${conversation.chatId}, turn: ${turnId}`;
  }
}

/** A turn's addressing: what its completion records intents for. */
type SettledTurn = Pick<TurnRef, 'chatId' | 'userId' | 'streamId'>;

interface OpenFollowUp {
  followUp: SettleFollowUp;
  queue: SettleQueue;
}

export interface TurnSettlementOptions {
  storage: AgentStorage;
  directory: AgentDirectory;
  streams: StreamStore;
  queue: TurnQueue;
  /** Whether the tree `thread` is in is being deleted, or its root is gone. */
  inDeletedTree: (thread: AgentThread) => Promise<boolean>;
  followUps: readonly SettleFollowUp[];
}

/**
 * Records one durable intent per settle follow-up before the turn queue
 * releases a turn, and runs those intents on each follow-up's own queue. A
 * process that dies before recording them leaves the turn's job unreleased:
 * it becomes an orphan, whose reconciliation records them. So a released
 * turn always has its follow-ups recorded. The stream's terminal status is
 * written earlier by StreamManager.persist, in its own unit.
 */
export class TurnSettlement {
  readonly #storage: AgentStorage;
  readonly #directory: AgentDirectory;
  readonly #streams: StreamStore;
  readonly #queue: TurnQueue;
  readonly #inDeletedTree: TurnSettlementOptions['inDeletedTree'];
  readonly #followUps: readonly OpenFollowUp[];

  private constructor(
    options: TurnSettlementOptions,
    followUps: readonly OpenFollowUp[],
  ) {
    this.#storage = options.storage;
    this.#directory = options.directory;
    this.#streams = options.streams;
    this.#queue = options.queue;
    this.#inDeletedTree = options.inDeletedTree;
    this.#followUps = followUps;
  }

  /** Opens each follow-up's intent queue, so any process can record intents. */
  static async open(options: TurnSettlementOptions): Promise<TurnSettlement> {
    const followUps: OpenFollowUp[] = [];
    for (const followUp of options.followUps) {
      followUps.push({
        followUp,
        queue: await options.storage.settleQueue(followUp.name),
      });
    }
    return new TurnSettlement(options, followUps);
  }

  /**
   * Records one intent per follow-up for `turn`, in one admission to its
   * tree. A turn whose stream is gone belongs to a deleted chat and records
   * nothing.
   */
  async complete(turn: SettledTurn): Promise<void> {
    await this.#admit(turn, async (scope) => {
      await this.#record(scope, turn);
    });
  }

  /**
   * Completes a mailbox wake that found no mail: its stream, which nothing
   * else ends, is marked `completed` in the same admission that records its
   * intents.
   */
  async completeEmptyWake(turn: SettledTurn): Promise<void> {
    await this.#admit(turn, async (scope, status) => {
      if (status === 'queued' || status === 'running') {
        await scope.streams.updateStreamStatus(turn.streamId, 'completed');
      }
      await this.#record(scope, turn);
    });
  }

  async #admit(
    turn: SettledTurn,
    work: (scope: AdmissionScope, status: StreamStatus) => Promise<void>,
  ): Promise<void> {
    const thread = await this.#directory.load({
      chatId: turn.chatId,
      userId: turn.userId,
    });
    const tree = {
      userId: turn.userId,
      treeId: thread?.treeId ?? turn.chatId,
    };
    await this.#storage.admit(tree, async (scope) => {
      const status = await scope.streams.getStreamStatus(turn.streamId);
      if (status === undefined) return;
      await work(scope, status);
    });
  }

  /** Consumes each follow-up's intents until disposed. */
  async work(): Promise<AsyncDisposable> {
    await using workers = new AsyncDisposableStack();
    for (const { followUp, queue } of this.#followUps) {
      workers.use(
        await queue.consume((intent) => this.#handle(followUp, intent)),
      );
    }
    return workers.move();
  }

  async #record(scope: AdmissionScope, turn: SettledTurn): Promise<void> {
    const intent: SettleIntent = {
      conversation: { chatId: turn.chatId, userId: turn.userId },
      turnId: turn.streamId,
    };
    for (const { followUp } of this.#followUps) {
      await scope.settleIntents.record(
        followUp.name,
        uuidv5(
          JSON.stringify(['settle', followUp.name, intent.turnId]),
          conversationNamespace(intent.conversation),
        ),
        intent,
      );
    }
  }

  /**
   * Done when the chat is gone or a newer turn is its latest, whose own
   * intent runs the follow-up; throws, so the queue retries, while the
   * intent's turn still holds its chat; reports a NonRetryableError as a
   * process warning and is done; lets every other failure out to be retried.
   */
  async #handle(followUp: SettleFollowUp, raw: SettleIntent): Promise<void> {
    const { conversation, turnId } = settleIntentSchema.parse(raw);
    const thread = await this.#directory.load(conversation);
    if (!thread || (await this.#inDeletedTree(thread))) return;
    if (await this.#superseded(thread, turnId)) return;
    if ((await this.#queue.getCurrentTurn(conversation))?.streamId === turnId) {
      throw new Error(
        `AgentRuntime: turn "${turnId}" of chat "${conversation.chatId}" has not settled yet; its follow-up "${followUp.name}" waits for it`,
      );
    }
    try {
      await followUp.run(conversation);
    } catch (error) {
      if (!isNonRetryableError(error)) throw error;
      process.emitWarning(
        new SettleFollowUpWarning(error, followUp.name, conversation, turnId),
      );
    }
  }

  /** Whether the chat's latest turn started after `turnId`. */
  async #superseded(thread: AgentThread, turnId: string): Promise<boolean> {
    const latest = thread.lastTurnId;
    if (latest === undefined || latest === turnId) return false;
    const own = await this.#streams.getStream(turnId);
    const newer = await this.#streams.getStream(latest);
    return (
      own === undefined ||
      (newer !== undefined && newer.createdAt > own.createdAt)
    );
  }
}
