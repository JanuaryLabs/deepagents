import type { Db, JobWithMetadata, PgBoss } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';

import {
  type ConsumeContext,
  type ConsumeOptions,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
} from './turn-queue.ts';

export interface PgBossTurnQueueOptions {
  queue?: string;
  /** Required for custom DB adapters; must match the PgBoss schema. */
  schema?: string;
  /** Hard cap on one turn attempt; the job fails past this. */
  expireInSeconds?: number;
  /** Dead-worker detection window; must be >= 10 (pg-boss constraint). */
  heartbeatSeconds?: number;
  pollingIntervalSeconds?: number;
  /** Required when PgBoss uses a custom database adapter. */
  withTransaction?: <T>(
    operation: (database: Pick<Db, 'executeSql'>) => Promise<T>,
  ) => Promise<T>;
}

type PgBossTransaction = NonNullable<PgBossTurnQueueOptions['withTransaction']>;

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * TurnQueue on pg-boss.
 *
 * - `key_strict_fifo` policy with `singletonKey = chatId` gives the per-chat
 *   serialization contract structurally: one active turn per chat, strict
 *   push order, cross-chat concurrency.
 * - `retryLimit: 0` — a crashed turn is never silently re-run (its bash
 *   already executed). It dead-letters instead.
 * - A failed job blocks its chat's key until acknowledged; the dead-letter
 *   consumer is that acknowledgement: it reports the orphan via
 *   `onOrphaned`, then deletes the source job, unblocking the chat.
 * - `deleteAfterSeconds: 0` — pg-boss never deletes a terminal job on a
 *   wall-clock timer. That is what makes a parked (cancelled) turn durable: it
 *   awaits its approval for as long as it takes, with no retention deadline.
 *   Cleanup is commit-driven instead — `consume` deletes a job the moment its
 *   turn runs and commits to the chain — so completed jobs don't accumulate.
 *   (`retentionSeconds`, which governs still-`created` jobs, can't be 0; its
 *   default 14d is never approached because a queued turn only waits behind one
 *   running turn.)
 * - Interrupting an active turn aborts the adapter-local handler but leaves its
 *   pg-boss row `active` until that handler exits. Cancelling the row itself
 *   would surrender the strict-FIFO key early and let the successor overlap.
 *   Cross-process handler abort comes from the runtime's durable stream
 *   cancellation; this queue remains the scheduler-ordering authority.
 *
 * The `PgBoss` instance is borrowed: the caller `start()`s and `stop()`s it.
 */
export class PgBossTurnQueue extends TurnQueue {
  #boss: PgBoss;
  #queue: string;
  #schema: string;
  #schemaConfigurationError?: string;
  #table?: string;
  #expireInSeconds: number;
  #cancelIntentTtlMs: number;
  #heartbeatSeconds: number;
  #pollingIntervalSeconds: number;
  #withTransaction?: PgBossTransaction;
  #active = new Map<string, Set<AbortController>>();
  #cancelIntents = new Map<string, number>();
  #cancelIntentExpiryTimer?: ReturnType<typeof globalThis.setTimeout>;

  constructor(boss: PgBoss, options: PgBossTurnQueueOptions = {}) {
    super();
    this.#boss = boss;
    this.#queue = options.queue ?? 'zukhruf-turns';
    const database = boss.getDb() as Db & {
      config?: { schema?: unknown };
      withTransaction?: PgBossTransaction;
    };
    const databaseTransaction = database.withTransaction?.bind(database);
    this.#withTransaction =
      options.withTransaction ??
      (databaseTransaction
        ? (operation) => databaseTransaction(operation)
        : undefined);
    const configuredSchema = database.config?.schema;
    const bossSchema =
      typeof configuredSchema === 'string' ? configuredSchema : undefined;
    this.#schema = options.schema ?? bossSchema ?? 'pgboss';
    if (options.schema === undefined && bossSchema === undefined) {
      this.#schemaConfigurationError =
        'PgBossTurnQueue cannot read the schema from a custom PgBoss database adapter; pass the PgBoss schema in options.schema';
    } else if (
      options.schema !== undefined &&
      bossSchema !== undefined &&
      options.schema !== bossSchema
    ) {
      this.#schemaConfigurationError = `PgBossTurnQueue schema "${options.schema}" does not match the PgBoss schema "${bossSchema}"`;
    }
    this.#expireInSeconds = options.expireInSeconds ?? 3600;
    this.#cancelIntentTtlMs = this.#expireInSeconds * 1_000;
    if (
      !Number.isFinite(this.#expireInSeconds) ||
      this.#expireInSeconds <= 0 ||
      !Number.isSafeInteger(this.#cancelIntentTtlMs) ||
      this.#cancelIntentTtlMs > Number.MAX_SAFE_INTEGER - Date.now()
    ) {
      throw new Error(
        'PgBossTurnQueue expireInSeconds must be a finite positive duration',
      );
    }
    this.#heartbeatSeconds = options.heartbeatSeconds ?? 30;
    this.#pollingIntervalSeconds = options.pollingIntervalSeconds ?? 1;
  }

  get queue(): string {
    return this.#queue;
  }

  get deadLetterQueue(): string {
    return `${this.#queue}-dead`;
  }

  async initialize(): Promise<void> {
    if (this.#schemaConfigurationError) {
      throw new Error(this.#schemaConfigurationError);
    }
    if (!this.#withTransaction) {
      throw new Error(
        'PgBossTurnQueue requires options.withTransaction when PgBoss uses a custom database adapter',
      );
    }
    if (!(await this.#boss.getQueue(this.deadLetterQueue))) {
      await this.#boss.createQueue(this.deadLetterQueue);
    }
    let queue = await this.#boss.getQueue(this.#queue);
    if (!queue) {
      await this.#boss.createQueue(this.#queue, {
        policy: 'key_strict_fifo',
        retryLimit: 0,
        expireInSeconds: this.#expireInSeconds,
        heartbeatSeconds: this.#heartbeatSeconds,
        deleteAfterSeconds: 0,
        deadLetter: this.deadLetterQueue,
      });
      queue = await this.#boss.getQueue(this.#queue);
    }
    if (!queue) throw new Error(`Queue "${this.#queue}" was not initialized`);
    this.#table = queue.table;
    try {
      const catalog = await this.#boss.getDb().executeSql(
        `SELECT table_name AS "table"
         FROM ${PgBossTurnQueue.#quoteIdentifier(this.#schema)}."queue"
         WHERE name = $1`,
        [this.#queue],
      );
      if (
        catalog.rows.length !== 1 ||
        (catalog.rows[0] as { table?: unknown }).table !== this.#table
      ) {
        throw new Error('queue catalog does not match');
      }
      await this.#boss
        .getDb()
        .executeSql(`SELECT 1 FROM ${this.#relation()} WHERE false`);
    } catch (cause) {
      throw new Error(
        `PgBossTurnQueue schema "${this.#schema}" does not match the PgBoss queue; pass the PgBoss schema in options.schema`,
        { cause },
      );
    }
  }

  async push(turn: TurnRef): Promise<void> {
    // pg-boss fetches `ORDER BY priority desc, created_on, id`. A monotonic
    // UUIDv7 job id makes the id tiebreak follow push order, so FIFO survives
    // created_on timestamp ties (millisecond-resolution clocks like PGlite).
    // Every push creates a job — delivery is at-least-once; turn-level dedup
    // lives in the consumer (the runtime skips terminal streams).
    // Continuations outrank waiting turns: revived parked jobs keep their
    // original (older) created_on, so priority is what puts the continuation
    // first.
    await this.#boss.send(this.#queue, turn, {
      id: uuidv7(),
      singletonKey: turn.chatId,
      priority: turn.kind === 'continuation' ? 1 : 0,
    });
  }

  override serialize<T>(
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const withTransaction = this.#withTransaction;
    if (!withTransaction) {
      throw new Error(
        'PgBossTurnQueue.serialize() requires options.withTransaction when PgBoss uses a custom database adapter',
      );
    }
    return withTransaction(async (database) => {
      await database.executeSql(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${this.#queue}:${chatId}`],
      );
      return operation();
    });
  }

  override async getTurnActivity(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnActivity> {
    const jobs = await this.#boss.findJobs<TurnRef>(this.#queue, {
      key: conversation.chatId,
    });
    const conversationJobs = jobs.filter(
      (job) =>
        job.data.userId === conversation.userId &&
        (job.state === 'created' ||
          job.state === 'retry' ||
          job.state === 'active'),
    );
    if (conversationJobs.some((job) => job.state === 'active')) {
      return 'running';
    }
    return conversationJobs.length > 0 ? 'queued' : 'idle';
  }

  override async getCurrentTurn(
    conversation: Pick<TurnRef, 'chatId' | 'userId'>,
  ): Promise<TurnRef | undefined> {
    const jobs = await this.#boss.findJobs<TurnRef>(this.#queue, {
      key: conversation.chatId,
    });
    return jobs
      .filter(
        (job) =>
          job.data.userId === conversation.userId &&
          (job.state === 'active' ||
            job.state === 'created' ||
            job.state === 'retry'),
      )
      .sort(PgBossTurnQueue.#interruptOrder)[0]?.data;
  }

  override async cancel(streamId: string): Promise<void> {
    this.#rememberCancelIntent(streamId);
    this.#abortLocal(streamId);
    const jobs = await this.#boss.findJobs<TurnRef>(this.#queue, {
      data: { streamId },
    });
    // An active row must retain the strict-FIFO key until its handler exits.
    // Delete only rows that are still queued at mutation time: a worker may
    // claim one after findJobs() returns, and pg-boss's public cancel/delete
    // methods do not provide the state predicate needed to close that race.
    // Remote active handlers are stopped by the runtime's durable stream
    // cancellation; their normal handler exit performs commit-driven GC.
    const queued = jobs
      .filter((job) => job.state === 'created' || job.state === 'retry')
      .map((job) => job.id);
    if (queued.length > 0) await this.#deleteIfStillQueued(queued);

    // Close the inverse race too: a local worker can claim after the first
    // controller scan but before the state-conditional delete.
    this.#abortLocal(streamId);
    const remaining = await this.#boss.findJobs<TurnRef>(this.#queue, {
      data: { streamId },
    });
    if (!remaining.some((job) => job.state === 'active')) {
      this.#forgetCancelIntent(streamId);
    }
  }

  async consume(
    handler: (turn: TurnRef, context: ConsumeContext) => Promise<void>,
    options: ConsumeOptions,
  ): Promise<AsyncDisposable> {
    const turnWorkerId = await this.#boss.work<TurnRef>(
      this.#queue,
      {
        localConcurrency: options.concurrency ?? 1,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
      },
      async ([job]) => {
        let parked = false;
        const localAbort = new AbortController();
        const active = this.#active.get(job.data.streamId) ?? new Set();
        active.add(localAbort);
        this.#active.set(job.data.streamId, active);
        if (this.#hasCancelIntent(job.data.streamId)) localAbort.abort();
        try {
          await handler(job.data, {
            signal: AbortSignal.any([job.signal, localAbort.signal]),
            // Parking = self-cancel: a cancelled job stops blocking the chat's
            // key and is revived (original created_on, so original order) by
            // resumeParked(). The worker's completion of a cancelled job is a
            // clean no-op (probe-verified).
            park: async () => {
              parked = true;
              await this.#boss.cancel(this.#queue, job.id);
            },
          });
        } finally {
          active.delete(localAbort);
          if (active.size === 0) {
            this.#active.delete(job.data.streamId);
            this.#forgetCancelIntent(job.data.streamId);
          }
        }
        // Commit-driven GC. A handler that returns without parking has run its
        // turn to a terminal stream and committed to the chain (the permanent
        // record) — the job is spent, so delete it now instead of leaning on a
        // wall-clock timer (`deleteAfterSeconds: 0` disables that). Deleting an
        // active job from inside its own handler is safe: pg-boss's subsequent
        // completion finds no row and no-ops (probe-verified, zero errors). A
        // parked turn is skipped — it must stay `cancelled` for resumeParked to
        // revive it. A throwing handler is skipped too — the throw propagates to
        // pg-boss and the turn dead-letters.
        if (!parked) {
          await this.#boss.deleteJob(this.#queue, job.id);
        }
      },
    );

    const deadWorkerId = await this.#boss.work(
      this.deadLetterQueue,
      {
        includeMetadata: true,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
      },
      async ([job]: JobWithMetadata<TurnRef>[]) => {
        try {
          await options.onOrphaned(
            job.data,
            PgBossTurnQueue.#orphanError(job.output),
          );
        } finally {
          // The failed source job owns the strict-FIFO key. Reconciliation may
          // retry through this DLQ job, but it must never retain that key and
          // wedge every later turn in the conversation.
          if (job.sourceId) {
            await this.#boss.deleteJob(this.#queue, job.sourceId);
          }
        }
      },
    );

    return {
      [Symbol.asyncDispose]: async () => {
        await this.#boss.offWork(this.#queue, { id: turnWorkerId });
        await this.#boss.offWork(this.deadLetterQueue, { id: deadWorkerId });
      },
    };
  }

  async resumeParked(chatId: string): Promise<void> {
    // Revives every cancelled job for the chat. A revived USER-cancelled
    // turn is harmless — the consumer's terminal-stream check skips it —
    // so no parked-vs-cancelled bookkeeping is needed here.
    const jobs = await this.#boss.findJobs(this.#queue, { key: chatId });
    const parked = jobs
      .filter((job) => job.state === 'cancelled')
      .map((job) => job.id);
    if (parked.length > 0) {
      await this.#boss.resume(this.#queue, parked);
    }
  }

  #abortLocal(streamId: string): void {
    for (const controller of this.#active.get(streamId) ?? []) {
      controller.abort();
    }
  }

  #rememberCancelIntent(streamId: string): void {
    this.#pruneCancelIntents();
    this.#cancelIntents.set(streamId, Date.now() + this.#cancelIntentTtlMs);
    this.#scheduleCancelIntentExpiry();
  }

  #hasCancelIntent(streamId: string): boolean {
    this.#pruneCancelIntents();
    return this.#cancelIntents.has(streamId);
  }

  #pruneCancelIntents(): void {
    const now = Date.now();
    for (const [streamId, expiresAt] of this.#cancelIntents) {
      if (expiresAt <= now) this.#cancelIntents.delete(streamId);
    }
    this.#scheduleCancelIntentExpiry();
  }

  #forgetCancelIntent(streamId: string): void {
    this.#cancelIntents.delete(streamId);
    this.#scheduleCancelIntentExpiry();
  }

  #scheduleCancelIntentExpiry(): void {
    if (this.#cancelIntentExpiryTimer !== undefined) {
      globalThis.clearTimeout(this.#cancelIntentExpiryTimer);
      this.#cancelIntentExpiryTimer = undefined;
    }
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const expiresAt of this.#cancelIntents.values()) {
      nextExpiry = Math.min(nextExpiry, expiresAt);
    }
    if (!Number.isFinite(nextExpiry)) return;

    const timer = globalThis.setTimeout(
      () => {
        if (this.#cancelIntentExpiryTimer !== timer) return;
        this.#cancelIntentExpiryTimer = undefined;
        this.#pruneCancelIntents();
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(1, nextExpiry - Date.now())),
    );
    this.#cancelIntentExpiryTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  async #deleteIfStillQueued(ids: string[]): Promise<void> {
    if (!this.#table) {
      throw new Error('PgBossTurnQueue.initialize() must run before cancel()');
    }
    await this.#boss.getDb().executeSql(
      `DELETE FROM ${this.#relation()}
       WHERE name = $1
         AND id = ANY($2::uuid[])
         AND state IN ('created', 'retry')`,
      [this.#queue, ids],
    );
  }

  #relation(): string {
    if (!this.#table) {
      throw new Error(
        'PgBossTurnQueue.initialize() must resolve its job table',
      );
    }
    return `${PgBossTurnQueue.#quoteIdentifier(this.#schema)}.${PgBossTurnQueue.#quoteIdentifier(this.#table)}`;
  }

  static #quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
  }

  static #orphanError(output: object | null | undefined): string {
    if (output && 'message' in output && typeof output.message === 'string') {
      return output.message;
    }
    return output ? JSON.stringify(output) : 'turn orphaned';
  }

  static #interruptOrder(
    left: JobWithMetadata<TurnRef>,
    right: JobWithMetadata<TurnRef>,
  ): number {
    if (left.state === 'active' && right.state !== 'active') return -1;
    if (left.state !== 'active' && right.state === 'active') return 1;
    if (left.priority !== right.priority) return right.priority - left.priority;
    const created = left.createdOn.getTime() - right.createdOn.getTime();
    return created || left.id.localeCompare(right.id);
  }
}
