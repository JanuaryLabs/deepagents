export interface Wake<T extends object> {
  id: string;
  runAt: Date;
  data: T;
}

/** Durable, at-least-once delivery of opaque one-shot wakes. */
export abstract class WakeScheduler<T extends object> {
  abstract schedule(wake: Wake<T>): Promise<void>;
  abstract cancel(id: string): Promise<void>;
  abstract consume(
    handler: (wake: Wake<T>) => Promise<void>,
  ): Promise<AsyncDisposable>;
}
