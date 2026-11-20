import { Lock } from '@zukhruf/async';
import { Declaration } from '@zukhruf/sqlite-drift';
import type { DatabaseSync } from 'node:sqlite';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

import type { PgBossTurnQueue } from '../queue/pg-boss.turn-queue.ts';
import {
  type ConsumeContext,
  type ConsumeOptions,
  type TransactionalTurnQueue,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
} from '../queue/turn-queue.ts';
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
  ],
  { rows: 'keep' },
);

const outboxRowSchema = z.object({ jobId: z.string(), turn: z.string() });

type Conversation = Pick<TurnRef, 'chatId' | 'userId'>;

interface OutboxedTurn {
  /** The pg-boss job id the relay pushes the turn as. */
  jobId: string;
  turn: TurnRef;
}

function parseTurn(text: string): TurnRef {
  // Written by `add` from a TurnRef; the outbox is this storage's own table.
  const turn: TurnRef = JSON.parse(text);
  return turn;
}

/**
 * Turns committed in SQLite and not yet pushed to pg-boss. Each method runs
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
 * the job id the outbox gave it, and deletes a row only after its push. A
 * process that dies between the two leaves the row, and the next drain pushes
 * it again as the same job.
 */
export class OutboxRelay {
  readonly #gate: SqliteAdmissionGate;
  readonly #outbox: TurnOutbox;
  readonly #queue: PgBossTurnQueue;
  /** Held by a drain, and by work that must not run while a row is between its push and its delete. */
  readonly #rows = new Lock();

  constructor(
    gate: SqliteAdmissionGate,
    outbox: TurnOutbox,
    queue: PgBossTurnQueue,
  ) {
    this.#gate = gate;
    this.#outbox = outbox;
    this.#queue = queue;
  }

  /** Resolves once every row added before the call has reached pg-boss. */
  drain(): Promise<void> {
    return this.between(async () => {
      for (;;) {
        const next = await this.#gate.call(async () => this.#outbox.oldest());
        if (!next) return;
        await this.#queue.pushAs(next.jobId, next.turn);
        await this.#gate.call(async () => this.#outbox.remove(next.jobId));
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
}
