import { EventEmitter, on } from 'node:events';
import type { PgBoss } from 'pg-boss';

const RESET = Symbol('reset');

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

  // The emitter carries raw payloads; values are parsed as they are read so
  // every yielded notification is typed by `parse` rather than by the emitter.
  const emitter = new EventEmitter();
  const notifications = on(emitter, 'notification', { signal });
  let ready = false;
  const handle = await listen(
    channel,
    (payload) => {
      emitter.emit('notification', payload);
    },
    () => {
      if (ready) emitter.emit('notification', RESET);
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
        for await (const event of notifications) {
          const [payload]: unknown[] = event;
          if (payload === RESET) {
            yield { type: 'reset' };
          } else if (typeof payload === 'string') {
            const value = parse(payload);
            if (value !== undefined) yield { type: 'change', value };
          }
        }
      } finally {
        await handle.close();
      }
    },
  };
}
