import { isDeepStrictEqual } from 'node:util';
import type { JobWithMetadata, PgBoss } from 'pg-boss';

import { type Wake, WakeScheduler } from './wake-scheduler.ts';

export interface PgBossWakeSchedulerOptions {
  /** Stable queue shared only by replicas of one agent tree. */
  queue: string;
  pollingIntervalSeconds?: number;
  expireInSeconds?: number;
  heartbeatSeconds?: number;
}

/** One-shot WakeScheduler backed by pg-boss `sendAfter()`. */
export class PgBossWakeScheduler<T extends object> extends WakeScheduler<T> {
  readonly #boss: PgBoss;
  readonly #queue: string;
  readonly #pollingIntervalSeconds: number;
  readonly #expireInSeconds: number;
  readonly #heartbeatSeconds: number;

  constructor(boss: PgBoss, options: PgBossWakeSchedulerOptions) {
    super();
    this.#boss = boss;
    this.#queue = options.queue;
    this.#pollingIntervalSeconds = options.pollingIntervalSeconds ?? 1;
    this.#expireInSeconds = options.expireInSeconds ?? 3_600;
    this.#heartbeatSeconds = options.heartbeatSeconds ?? 30;
  }

  async initialize(): Promise<void> {
    await this.#boss.createQueue(this.#queue, {
      retryLimit: 20,
      retryDelay: 1,
      retryBackoff: true,
      retryDelayMax: 60,
      expireInSeconds: this.#expireInSeconds,
      heartbeatSeconds: this.#heartbeatSeconds,
    });
  }

  override async schedule(wake: Wake<T>): Promise<void> {
    if (!wake.id.trim())
      throw new Error('WakeScheduler wake id cannot be empty');
    if (Number.isNaN(wake.runAt.getTime())) {
      throw new Error('WakeScheduler runAt must be a valid Date');
    }

    const inserted = await this.#boss.sendAfter(
      this.#queue,
      wake.data,
      { id: wake.id },
      wake.runAt,
    );
    if (inserted !== null) return;

    const existing = (
      await this.#boss.findJobs<T>(this.#queue, { id: wake.id })
    )[0];
    if (!existing) {
      const retried = await this.#boss.sendAfter(
        this.#queue,
        wake.data,
        { id: wake.id },
        wake.runAt,
      );
      if (retried !== null) return;
      throw new Error(`WakeScheduler could not persist wake "${wake.id}"`);
    }
    if (
      existing.startAfter.getTime() !== wake.runAt.getTime() ||
      !isDeepStrictEqual(existing.data, wake.data)
    ) {
      throw new Error(`WakeScheduler wake id "${wake.id}" is already in use`);
    }
    if (existing.state === 'failed') {
      await this.#boss.retry(this.#queue, wake.id);
    } else if (existing.state === 'cancelled') {
      await this.#boss.resume(this.#queue, wake.id);
    }
  }

  override async cancel(id: string): Promise<void> {
    if (!id.trim()) throw new Error('WakeScheduler wake id cannot be empty');
    await this.#boss.cancel(this.#queue, id);
  }

  override async consume(
    handler: (wake: Wake<T>) => Promise<void>,
    waitForActive?: boolean,
  ): Promise<AsyncDisposable> {
    const workerId = await this.#boss.work<
      T,
      void,
      { includeMetadata: true; pollingIntervalSeconds: number }
    >(
      this.#queue,
      {
        includeMetadata: true,
        pollingIntervalSeconds: this.#pollingIntervalSeconds,
      },
      async ([job]: JobWithMetadata<T>[]) => {
        await handler({
          id: job.id,
          runAt: job.startAfter,
          data: job.data,
        });
        await this.#boss.deleteJob(this.#queue, job.id);
      },
    );
    return {
      [Symbol.asyncDispose]: () =>
        this.#boss.offWork(this.#queue, { id: workerId, wait: waitForActive }),
    };
  }
}
