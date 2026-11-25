import { Lock } from '@zukhruf/async';
import { Declaration } from '@zukhruf/sqlite-drift';
import type { DatabaseSync } from 'node:sqlite';
import type { PgBoss } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import type { PgBossTurnQueue } from '../queue/pg-boss.turn-queue.ts';
import type { SettleIntent } from '../queue/settle-intent.ts';
import {
  type ConsumeContext,
  type ConsumeOptions,
  type TransactionalTurnQueue,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
} from '../queue/turn-queue.ts';
import type { Wake } from '../queue/wake-scheduler.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';
import type { SqliteAdmissionGate } from './sqlite-admission-gate.ts';

// SQLite stores the text of each CREATE and @zukhruf/sqlite-drift compares
// it, so the text after each object name must stay byte-identical.
const tables = new Declaration(
  [
    `CREATE TABLE zukhruf_turn_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    turn TEXT NOT NULL
  )`,
    `CREATE INDEX zukhruf_turn_outbox_conversation
    ON zukhruf_turn_outbox (chat_id, user_id, sequence)`,
    `CREATE TABLE zukhruf_settle_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    queue TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    intent TEXT NOT NULL
  )`,
    `CREATE TABLE zukhruf_wake_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    queue TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    data TEXT NOT NULL
  )`,
  ],
  { rows: 'keep' },
);

const outboxRowSchema = z.object({ jobId: z.string(), turn: z.string() });

const settleRowSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  intent: z.string(),
});

const wakeRowSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  runAt: z.number(),
  data: z.string(),
});

type Conversation = Pick<TurnRef, 'chatId' | 'userId'>;

interface OutboxedTurn {
  /** The pg-boss job id the relay pushes the turn as. */
  jobId: string;
  turn: TurnRef;
}

/** A settle intent committed in SQLite and not yet sent to its pg-boss queue. */
interface OutboxedSettleIntent {
  jobId: string;
  queue: string;
  intent: SettleIntent;
}

/** A sandbox idle wake committed in SQLite and not yet scheduled on its pg-boss queue. */
interface OutboxedWake {
  queue: string;
  wake: Wake<SandboxIdleWake>;
}

function parseTurn(text: string): TurnRef {
  // Written by `add` from a TurnRef; the outbox is this storage's own table.
  const turn: TurnRef = JSON.parse(text);
  return turn;
}

function parseSettleIntent(text: string): SettleIntent {
  // Written by `addSettleIntent` from a SettleIntent; the outbox is this storage's own table.
  const intent: SettleIntent = JSON.parse(text);
  return intent;
}

function parseIdleWake(text: string): SandboxIdleWake {
  // Written by `addWake` from a SandboxIdleWake; the outbox is this storage's own table.
  const wake: SandboxIdleWake = JSON.parse(text);
  return wake;
}

/**
 * Turns, settle intents and sandbox idle wakes committed in SQLite and not
 * yet sent to pg-boss, in three tables: a turn row keeps its chat's FIFO
 * order and counts as queued work, a settle intent row only names the queue
 * it goes to, and a wake row also its due time. Each method runs
 * synchronously on the storage's connection, so inside an admission it reads
 * and writes in the admission's transaction.
 */
export class TurnOutbox {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
    tables.apply(database);
  }

  add(turn: TurnRef): void {
    // A UUIDv7 grows with push order, which pg-boss uses to break created_on ties.
    this.#database
      .prepare(
        `INSERT INTO zukhruf_turn_outbox (job_id, chat_id, user_id, stream_id, turn)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv7(),
        turn.chatId,
        turn.userId,
        turn.streamId,
        JSON.stringify(turn),
      );
  }

  oldest(): OutboxedTurn | undefined {
    return this.#outboxed(
      this.#database
        .prepare(
          `SELECT job_id AS jobId, turn FROM zukhruf_turn_outbox
           ORDER BY sequence LIMIT 1`,
        )
        .get(),
    );
  }

  oldestOf(conversation: Conversation): TurnRef | undefined {
    return this.#outboxed(
      this.#database
        .prepare(
          `SELECT job_id AS jobId, turn FROM zukhruf_turn_outbox
           WHERE chat_id = ? AND user_id = ?
           ORDER BY sequence LIMIT 1`,
        )
        .get(conversation.chatId, conversation.userId),
    )?.turn;
  }

  holds(conversation: Conversation): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM zukhruf_turn_outbox
           WHERE chat_id = ? AND user_id = ? LIMIT 1`,
        )
        .get(conversation.chatId, conversation.userId) !== undefined
    );
  }

  remove(jobId: string): void {
    this.#database
      .prepare('DELETE FROM zukhruf_turn_outbox WHERE job_id = ?')
      .run(jobId);
  }

  removeStream(streamId: string): void {
    this.#database
      .prepare('DELETE FROM zukhruf_turn_outbox WHERE stream_id = ?')
      .run(streamId);
  }

  /** Adds `intent` for `queue` as the job `jobId`, unless the outbox already holds that job. */
  addSettleIntent(queue: string, jobId: string, intent: SettleIntent): void {
    this.#database
      .prepare(
        `INSERT INTO zukhruf_settle_outbox (job_id, queue, chat_id, user_id, intent)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (job_id) DO NOTHING`,
      )
      .run(
        jobId,
        queue,
        intent.conversation.chatId,
        intent.conversation.userId,
        JSON.stringify(intent),
      );
  }

  oldestSettleIntent(): OutboxedSettleIntent | undefined {
    const row = this.#database
      .prepare(
        `SELECT job_id AS jobId, queue, intent FROM zukhruf_settle_outbox
         ORDER BY sequence LIMIT 1`,
      )
      .get();
    if (row === undefined) return undefined;
    const { jobId, queue, intent } = settleRowSchema.parse(row);
    return { jobId, queue, intent: parseSettleIntent(intent) };
  }

  removeSettleIntent(jobId: string): void {
    this.#database
      .prepare('DELETE FROM zukhruf_settle_outbox WHERE job_id = ?')
      .run(jobId);
  }

  /** Adds `wake` for `queue` as the job of its id, unless the outbox already holds that job. */
  addWake(queue: string, wake: Wake<SandboxIdleWake>): void {
    this.#database
      .prepare(
        `INSERT INTO zukhruf_wake_outbox (job_id, queue, chat_id, user_id, run_at, data)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (job_id) DO NOTHING`,
      )
      .run(
        wake.id,
        queue,
        wake.data.conversation.chatId,
        wake.data.conversation.userId,
        wake.runAt.getTime(),
        JSON.stringify(wake.data),
      );
  }

  oldestWake(): OutboxedWake | undefined {
    const row = this.#database
      .prepare(
        `SELECT job_id AS jobId, queue, run_at AS runAt, data FROM zukhruf_wake_outbox
         ORDER BY sequence LIMIT 1`,
      )
      .get();
    if (row === undefined) return undefined;
    const { jobId, queue, runAt, data } = wakeRowSchema.parse(row);
    return {
      queue,
      wake: { id: jobId, runAt: new Date(runAt), data: parseIdleWake(data) },
    };
  }

  removeWake(jobId: string): void {
    this.#database
      .prepare('DELETE FROM zukhruf_wake_outbox WHERE job_id = ?')
      .run(jobId);
  }

  /** Removes the conversation's turns, settle intents and wakes, as deleting its chat does. */
  removeConversation(conversation: Conversation): void {
    for (const table of [
      'zukhruf_turn_outbox',
      'zukhruf_settle_outbox',
      'zukhruf_wake_outbox',
    ]) {
      this.#database
        .prepare(`DELETE FROM ${table} WHERE chat_id = ? AND user_id = ?`)
        .run(conversation.chatId, conversation.userId);
    }
  }

  #outboxed(row: unknown): OutboxedTurn | undefined {
    if (row === undefined) return undefined;
    const { jobId, turn } = outboxRowSchema.parse(row);
    return { jobId, turn: parseTurn(turn) };
  }
}

/** Activity of a conversation whose queue reports `queued` while one of its turns waits in the outbox. */
function withOutboxed(activity: TurnActivity, outboxed: boolean): TurnActivity {
  if (activity === 'running') return activity;
  return outboxed ? 'queued' : activity;
}

/**
 * Pushes outboxed turns to pg-boss in outbox order, one at a time, each as
 * the job id the outbox gave it, then sends the outboxed settle intents and
 * wakes the same way, and deletes a row only after its push. A process that dies
 * between the two leaves the row, and the next drain pushes it again as the
 * same job.
 */
export class OutboxRelay {
  readonly #gate: SqliteAdmissionGate;
  readonly #outbox: TurnOutbox;
  readonly #queue: PgBossTurnQueue;
  readonly #boss: PgBoss;
  /** Held by a drain, and by work that must not run while a row is between its push and its delete. */
  readonly #rows = new Lock();

  constructor(
    gate: SqliteAdmissionGate,
    outbox: TurnOutbox,
    queue: PgBossTurnQueue,
    boss: PgBoss,
  ) {
    this.#gate = gate;
    this.#outbox = outbox;
    this.#queue = queue;
    this.#boss = boss;
  }

  /** Resolves once every row added before the call has reached pg-boss. */
  drain(): Promise<void> {
    return this.between(async () => {
      for (;;) {
        const next = await this.#gate.call(async () => this.#outbox.oldest());
        if (!next) break;
        await this.#queue.pushAs(next.jobId, next.turn);
        await this.#gate.call(async () => this.#outbox.remove(next.jobId));
      }
      for (;;) {
        const next = await this.#gate.call(async () =>
          this.#outbox.oldestSettleIntent(),
        );
        if (!next) break;
        await this.#boss.send(next.queue, next.intent, { id: next.jobId });
        await this.#gate.call(async () =>
          this.#outbox.removeSettleIntent(next.jobId),
        );
      }
      for (;;) {
        const next = await this.#gate.call(async () =>
          this.#outbox.oldestWake(),
        );
        if (!next) return;
        const { queue, wake } = next;
        await this.#boss.sendAfter(
          queue,
          wake.data,
          { id: wake.id },
          wake.runAt,
        );
        await this.#gate.call(async () => this.#outbox.removeWake(wake.id));
      }
    });
  }

  /** Runs `operation` while no drain runs. */
  between<T>(operation: () => Promise<T>): Promise<T> {
    return this.#rows.run(operation, { signal: undefined });
  }
}

/**
 * The embedded storage's turn queue: every push lands in the outbox and the
 * relay moves it to pg-boss, so turns of one chat reach pg-boss in push order
 * whether or not an admission pushed them. A conversation with a turn in the
 * outbox reports `queued`.
 */
export class OutboxTurnQueue extends TurnQueue {
  readonly #gate: SqliteAdmissionGate;
  readonly #outbox: TurnOutbox;
  readonly #relay: OutboxRelay;
  readonly #queue: PgBossTurnQueue;

  constructor(parts: {
    gate: SqliteAdmissionGate;
    outbox: TurnOutbox;
    relay: OutboxRelay;
    queue: PgBossTurnQueue;
  }) {
    super();
    this.#gate = parts.gate;
    this.#outbox = parts.outbox;
    this.#relay = parts.relay;
    this.#queue = parts.queue;
  }

  /** The view an admission pushes and counts through: its pushes are outbox rows of its transaction. */
  scope(): TransactionalTurnQueue {
    return {
      push: async (turn) => this.#outbox.add(turn),
      getTurnActivity: async (conversation) => {
        const outboxed = this.#outbox.holds(conversation);
        return withOutboxed(
          await this.#queue.getTurnActivity(conversation),
          outboxed,
        );
      },
    };
  }

  /** Resolves once the turn is in pg-boss. */
  async push(turn: TurnRef): Promise<void> {
    await this.#gate.call(async () => this.#outbox.add(turn));
    await this.#relay.drain();
  }

  async getTurnActivity(conversation: Conversation): Promise<TurnActivity> {
    // Outbox first: the relay deletes a row only after pg-boss holds its job.
    const outboxed = await this.#gate.call(async () =>
      this.#outbox.holds(conversation),
    );
    return withOutboxed(
      await this.#queue.getTurnActivity(conversation),
      outboxed,
    );
  }

  async getCurrentTurn(
    conversation: Conversation,
  ): Promise<TurnRef | undefined> {
    const outboxed = await this.#gate.call(async () =>
      this.#outbox.oldestOf(conversation),
    );
    return (await this.#queue.getCurrentTurn(conversation)) ?? outboxed;
  }

  cancel(streamId: string): Promise<void> {
    return this.#relay.between(async () => {
      await this.#gate.call(async () => this.#outbox.removeStream(streamId));
      await this.#queue.cancel(streamId);
    });
  }

  consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    return this.#queue.consume(handler, options);
  }

  resumeParked(chatId: string): Promise<void> {
    return this.#queue.resumeParked(chatId);
  }

  forget(conversation: Conversation): Promise<void> {
    return this.#relay.between(async () => {
      await this.#gate.call(async () =>
        this.#outbox.removeConversation(conversation),
      );
      await this.#queue.forget(conversation);
    });
  }
}
