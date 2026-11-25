export interface Wake<T extends object> {
  id: string;
  runAt: Date;
  data: T;
}

/** Schedules wakes in a caller's unit: workers see them only once it commits. */
export interface TransactionalWakeScheduler<T extends object> {
  /** Schedules `wake`; scheduling an id the queue still holds adds nothing. */
  schedule(wake: Wake<T>): Promise<void>;
}

/** Durable, at-least-once delivery of opaque one-shot wakes. */
export abstract class WakeScheduler<T extends object> {
  abstract schedule(wake: Wake<T>): Promise<void>;
  abstract cancel(id: string): Promise<void>;
  abstract consume(
    handler: (wake: Wake<T>) => Promise<void>,
  ): Promise<AsyncDisposable>;
}
