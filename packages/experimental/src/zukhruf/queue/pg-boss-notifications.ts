import { EventEmitter, on } from 'node:events';
import type { PgBoss } from 'pg-boss';

export type PgBossNotification<Value> =
  { type: 'change'; value: Value } | { type: 'reset' };

/** A LISTEN subscription that is live before it is returned. */
export async function pgBossNotifications<Value>(
  boss: PgBoss,
  channel: string,
  parse: (payload: string) => Value | undefined,
  signal: AbortSignal,
): Promise<AsyncIterable<PgBossNotification<Value>>> {
  signal.throwIfAborted();
  const db = boss.getDb();
  const listen = db.listen?.bind(db);
  if (!listen) {
    throw new Error('pg-boss database does not support LISTEN');
  }

  const emitter = new EventEmitter();
  const notifications = on(emitter, 'notification', { signal });
  let ready = false;
  const handle = await listen(
    channel,
    (payload) => {
      const value = parse(payload);
      if (value !== undefined) {
        emitter.emit('notification', { type: 'change', value });
      }
    },
    () => {
      if (ready) emitter.emit('notification', { type: 'reset' });
    },
  );
  ready = true;
  if (signal.aborted) {
    await handle.close();
    signal.throwIfAborted();
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const [notification] of notifications) {
          yield notification as PgBossNotification<Value>;
        }
      } finally {
        await handle.close();
      }
    },
  };
}
