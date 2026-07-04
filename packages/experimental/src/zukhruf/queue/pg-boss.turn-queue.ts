import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';

import {
  type ConsumeContext,
  type ConsumeOptions,
  TurnQueue,
  type TurnRef,
} from './turn-queue.ts';

export interface PgBossTurnQueueOptions {
  queue?: string;
  /** Hard cap on one turn attempt; the job fails past this. */
  expireInSeconds?: number;
  /** Dead-worker detection window; must be >= 10 (pg-boss constraint). */
  heartbeatSeconds?: number;
  pollingIntervalSeconds?: number;
}

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
 *
 * The `PgBoss` instance is borrowed: the caller `start()`s and `stop()`s it.
 */
export class PgBossTurnQueue extends TurnQueue {
  #boss: PgBoss;
  #queue: string;
  #expireInSeconds: number;
  #heartbeatSeconds: number;
  #pollingIntervalSeconds: number;

  constructor(boss: PgBoss, options: PgBossTurnQueueOptions = {}) {
    super();
    this.#boss = boss;
    this.#queue = options.queue ?? 'zukhruf-turns';
    this.#expireInSeconds = options.expireInSeconds ?? 3600;
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
    if (!(await this.#boss.getQueue(this.deadLetterQueue))) {
      await this.#boss.createQueue(this.deadLetterQueue);
    }
    if (!(await this.#boss.getQueue(this.#queue))) {
      await this.#boss.createQueue(this.#queue, {
        policy: 'key_strict_fifo',
        retryLimit: 0,
        expireInSeconds: this.#expireInSeconds,
        heartbeatSeconds: this.#heartbeatSeconds,
        deleteAfterSeconds: 0,
        deadLetter: this.deadLetterQueue,
      });
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
        await handler(job.data, {
          signal: job.signal,
          // Parking = self-cancel: a cancelled job stops blocking the chat's
          // key and is revived (original created_on, so original order) by
          // resumeParked(). The worker's completion of a cancelled job is a
          // clean no-op (probe-verified).
          park: async () => {
            parked = true;
            await this.#boss.cancel(this.#queue, job.id);
          },
        });
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
        await options.onOrphaned(job.data, orphanError(job.output));
        if (job.sourceId) {
          await this.#boss.deleteJob(this.#queue, job.sourceId);
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
}

function orphanError(output: object | null | undefined): string {
  if (output && 'message' in output && typeof output.message === 'string') {
    return output.message;
  }
  return output ? JSON.stringify(output) : 'turn orphaned';
}
