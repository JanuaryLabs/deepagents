import { EventEmitter, on } from 'node:events';
import { createRequire } from 'node:module';
import pMemoize from 'p-memoize';
import type { Notification, Pool, PoolClient, PoolConfig } from 'pg';
import { z } from 'zod';

import { parseJson } from '../store/columns.ts';
import { lockSchemaDDL } from '../store/postgres-schema-lock.ts';
import type { StreamChange, StreamChangeSource } from './change-source.ts';
import {
  DEFAULT_POSTGRES_STREAM_CHANGES_CHANNEL,
  postgresStreamNotifyDDL,
} from './ddl.stream.postgres-notify.ts';

export interface PostgresNotifyChangeSourceOptions {
  pool: Pool | PoolConfig | string;
  schema?: string;
  channel?: string;
}

interface ListenerHandlers {
  readonly notification: (message: Notification) => void;
  readonly error: (error: Error) => void;
  readonly end: () => void;
}

/** No LISTEN connection: the next subscriber opens one. */
const NOT_LISTENING = {
  release: (): Promise<void> => Promise.resolve(),
  fail: (): void => {},
};

/** The LISTEN connection, with the handlers this source put on it. */
class Listening {
  readonly #client: PoolClient;
  readonly #handlers: ListenerHandlers;

  constructor(client: PoolClient, handlers: ListenerHandlers) {
    this.#client = client;
    this.#handlers = handlers;
    client.on('notification', handlers.notification);
    client.on('error', handlers.error);
    client.on('end', handlers.end);
  }

  /** Stops listening and returns the connection to the pool. */
  async release(channel: string): Promise<void> {
    this.#detach();
    try {
      await this.#client.query(`UNLISTEN ${quoteIdentifier(channel)}`);
    } finally {
      this.#client.release();
    }
  }

  /** Gives a broken connection back for the pool to destroy. */
  fail(error: Error | true): void {
    this.#detach();
    this.#client.release(error);
  }

  #detach(): void {
    this.#client.off('notification', this.#handlers.notification);
    this.#client.off('error', this.#handlers.error);
    this.#client.off('end', this.#handlers.end);
  }
}

/** A wakeup for one stream, wrapped so a subscription can tell it from other events. */
class ChangeDelivery {
  readonly change: StreamChange;

  constructor(change: StreamChange) {
    this.change = change;
  }
}

export class PostgresNotifyChangeSource implements StreamChangeSource {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #channel: string;
  readonly #ownsPool: boolean;
  /** Aborts when close() starts: every subscription ends, and no LISTEN connection opens. */
  readonly #closed = new AbortController();
  /** Emits `stream:<id>` with a ChangeDelivery; `error` fails every subscription. */
  readonly #changes = new EventEmitter().setMaxListeners(0);
  #subscriptions = 0;
  #listener: Listening | typeof NOT_LISTENING = NOT_LISTENING;
  /** Concurrent subscribers share one LISTEN setup; a failed one runs again. */
  readonly #listen = pMemoize(() => this.#openListener(), { cache: false });

  readonly #handlers: ListenerHandlers = {
    notification: (message) => {
      this.#handleNotification(message);
    },
    error: (error) => {
      this.#failListener(error);
    },
    end: () => {
      if (!this.#closed.signal.aborted) {
        this.#failListener(
          new Error('PostgreSQL stream notification listener ended'),
        );
      }
    },
  };

  private constructor(options: PostgresNotifyChangeSourceOptions) {
    const schema = options.schema ?? 'public';
    const channel = options.channel ?? DEFAULT_POSTGRES_STREAM_CHANGES_CHANNEL;
    assertIdentifier(schema, 'schema');
    assertIdentifier(channel, 'channel');
    this.#schema = schema;
    this.#channel = channel;

    const pg = PostgresNotifyChangeSource.#requirePg();
    if (options.pool instanceof pg.Pool) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool =
        typeof options.pool === 'string'
          ? new pg.Pool({ connectionString: options.pool })
          : new pg.Pool(options.pool);
      this.#ownsPool = true;
    }
  }

  static #requirePg(): typeof import('pg') {
    try {
      const require = createRequire(import.meta.url);
      return require('pg');
    } catch {
      throw new Error(
        'PostgresNotifyChangeSource requires the "pg" package. Install it with: npm install pg',
      );
    }
  }

  /** Opens the source: installs the notify triggers before it returns. */
  static async create(
    options: PostgresNotifyChangeSourceOptions,
  ): Promise<PostgresNotifyChangeSource> {
    const source = new PostgresNotifyChangeSource(options);
    try {
      await source.#pool.query(
        lockSchemaDDL(
          postgresStreamNotifyDDL(source.#schema, source.#channel),
          source.#schema,
        ),
      );
    } catch (error) {
      await source.close();
      throw error;
    }
    return source;
  }

  async *subscribe(
    streamId: string,
    signal: AbortSignal,
  ): AsyncIterable<StreamChange> {
    if (this.#closed.signal.aborted) {
      throw new Error('PostgresNotifyChangeSource is closed.');
    }
    if (signal.aborted) return;
    // Listens before LISTEN is ready, so a change in that window is kept.
    const changes = on(this.#changes, `stream:${streamId}`, {
      signal: AbortSignal.any([signal, this.#closed.signal]),
    });
    this.#subscriptions += 1;
    try {
      await this.#ensureListening();
      if (signal.aborted || this.#closed.signal.aborted) return;
      yield { kind: 'tick' };

      for await (const [delivery] of changes) {
        if (delivery instanceof ChangeDelivery) yield delivery.change;
      }
    } catch (error) {
      // The caller's signal or close() ended the subscription.
      if (error instanceof Error && error.name === 'AbortError') return;
      throw error;
    } finally {
      this.#subscriptions -= 1;
      await changes.return?.();
      await this.#releaseListenerIfIdle();
    }
  }

  async close(): Promise<void> {
    if (this.#closed.signal.aborted) return;
    this.#closed.abort();

    try {
      // Joins a LISTEN setup in flight; it sees close() and destroys its client.
      await this.#listen();
    } catch {
      // Listener setup already released the failed client.
    }
    await this.#releaseListener();

    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  async #ensureListening(): Promise<void> {
    if (this.#listener instanceof Listening) return;
    await this.#listen();
  }

  async #openListener(): Promise<void> {
    if (this.#closed.signal.aborted) return;
    const client = await this.#pool.connect();
    const listening = new Listening(client, this.#handlers);
    try {
      await client.query(`LISTEN ${quoteIdentifier(this.#channel)}`);
    } catch (error) {
      listening.fail(true);
      throw error;
    }
    if (this.#closed.signal.aborted) {
      listening.fail(true);
      return;
    }
    this.#listener = listening;
  }

  #handleNotification(message: Notification): void {
    if (message.channel !== this.#channel || !message.payload) return;

    const payload = parsePayload(message.payload);
    if (!payload) return;
    if (payload.schema !== this.#schema) return;
    if (payload.kind !== 'chunks' && payload.kind !== 'status') return;

    const change: StreamChange =
      payload.kind === 'chunks' ? { kind: 'chunks' } : { kind: 'status' };
    this.#changes.emit(
      `stream:${payload.streamId}`,
      new ChangeDelivery(change),
    );
  }

  #failListener(error: Error): void {
    const listener = this.#listener;
    this.#listener = NOT_LISTENING;
    listener.fail(error);
    if (this.#changes.listenerCount('error') > 0) {
      this.#changes.emit('error', error);
    }
  }

  async #releaseListenerIfIdle(): Promise<void> {
    if (this.#subscriptions > 0) return;
    await this.#releaseListener();
  }

  async #releaseListener(): Promise<void> {
    const listener = this.#listener;
    this.#listener = NOT_LISTENING;
    await listener.release(this.#channel);
  }
}

/** What the notify triggers in ddl.stream.postgres-notify.ts send. */
const notificationPayload = z.object({
  schema: z.string(),
  streamId: z.string(),
  kind: z.string(),
});

function parsePayload(
  payload: string,
): z.output<typeof notificationPayload> | undefined {
  try {
    const parsed = notificationPayload.safeParse(parseJson(payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z_]\w*$/.test(value)) {
    throw new Error(`Invalid ${label} name: "${value}"`);
  }
}
