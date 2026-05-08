import { createRequire } from 'node:module';
import type { Notification, Pool, PoolClient, PoolConfig } from 'pg';

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

type Subscriber = ChangeQueue<StreamChange>;

export class PostgresNotifyChangeSource implements StreamChangeSource {
  #pool: Pool;
  #schema: string;
  #channel: string;
  #ownsPool: boolean;
  #listener: PoolClient | undefined;
  #listenPromise: Promise<void> | undefined;
  #isInitialized = false;
  #isClosing = false;
  #isClosed = false;
  #subscribers = new Map<string, Set<Subscriber>>();

  #onNotification = (message: Notification): void => {
    this.#handleNotification(message);
  };

  #onListenerError = (error: Error): void => {
    this.#failListener(error);
  };

  #onListenerEnd = (): void => {
    if (!this.#isClosing) {
      this.#failListener(
        new Error('PostgreSQL stream notification listener ended'),
      );
    }
  };

  constructor(options: PostgresNotifyChangeSourceOptions) {
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

  async initialize(): Promise<void> {
    await this.#pool.query(
      postgresStreamNotifyDDL(this.#schema, this.#channel),
    );
    this.#isInitialized = true;
  }

  async *subscribe(
    streamId: string,
    signal: AbortSignal,
  ): AsyncIterable<StreamChange> {
    this.#ensureInitialized();
    this.#ensureOpen();
    const queue = new ChangeQueue<StreamChange>();
    this.#addSubscriber(streamId, queue);

    const cleanup = () => {
      queue.close();
      this.#removeSubscriber(streamId, queue);
    };
    signal.addEventListener('abort', cleanup, { once: true });

    try {
      await this.#ensureListening();
      if (signal.aborted || this.#isClosed) return;
      yield { kind: 'tick' };

      while (!signal.aborted && !this.#isClosed) {
        const change = await queue.next(signal);
        if (!change) return;
        yield change;
      }
    } finally {
      signal.removeEventListener('abort', cleanup);
      cleanup();
      await this.#releaseListenerIfIdle();
    }
  }

  async close(): Promise<void> {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#isClosing = true;

    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.close();
      }
    }
    this.#subscribers.clear();

    if (this.#listenPromise) {
      try {
        await this.#listenPromise;
      } catch {
        // Listener setup already released the failed client.
      }
    }
    await this.#releaseListener();

    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  #ensureInitialized(): void {
    if (!this.#isInitialized) {
      throw new Error(
        'PostgresNotifyChangeSource not initialized. Call await source.initialize() after construction.',
      );
    }
  }

  #ensureOpen(): void {
    if (this.#isClosed) {
      throw new Error('PostgresNotifyChangeSource is closed.');
    }
  }

  async #ensureListening(): Promise<void> {
    this.#ensureOpen();
    if (this.#listener) return;
    if (this.#listenPromise) return this.#listenPromise;

    this.#listenPromise = (async () => {
      const listener = await this.#pool.connect();
      let success = false;
      try {
        listener.on('notification', this.#onNotification);
        listener.on('error', this.#onListenerError);
        listener.on('end', this.#onListenerEnd);
        await listener.query(`LISTEN ${quoteIdentifier(this.#channel)}`);
        if (this.#isClosed) {
          return;
        }
        this.#listener = listener;
        success = true;
      } finally {
        this.#listenPromise = undefined;
        if (!success) {
          listener.off('notification', this.#onNotification);
          listener.off('error', this.#onListenerError);
          listener.off('end', this.#onListenerEnd);
          listener.release(true);
        }
      }
    })();

    return this.#listenPromise;
  }

  #handleNotification(message: Notification): void {
    if (message.channel !== this.#channel || !message.payload) return;

    const payload = parsePayload(message.payload);
    if (!payload) return;
    if (payload.schema !== this.#schema) return;
    if (payload.kind !== 'chunks' && payload.kind !== 'status') return;

    const subscribers = this.#subscribers.get(payload.streamId);
    if (!subscribers) return;

    const change: StreamChange =
      payload.kind === 'chunks' ? { kind: 'chunks' } : { kind: 'status' };
    for (const subscriber of subscribers) {
      subscriber.push(change);
    }
  }

  #failListener(error: Error): void {
    const listener = this.#listener;
    this.#listener = undefined;
    this.#listenPromise = undefined;
    if (listener) {
      listener.off('notification', this.#onNotification);
      listener.off('error', this.#onListenerError);
      listener.off('end', this.#onListenerEnd);
      listener.release(error);
    }

    for (const subscribers of this.#subscribers.values()) {
      for (const subscriber of subscribers) {
        subscriber.fail(error);
      }
    }
    this.#subscribers.clear();
  }

  async #releaseListenerIfIdle(): Promise<void> {
    if (this.#subscribers.size > 0) return;
    await this.#releaseListener();
  }

  async #releaseListener(): Promise<void> {
    const listener = this.#listener;
    if (!listener) return;

    this.#listener = undefined;
    listener.off('notification', this.#onNotification);
    listener.off('error', this.#onListenerError);
    listener.off('end', this.#onListenerEnd);
    try {
      await listener.query(`UNLISTEN ${quoteIdentifier(this.#channel)}`);
    } finally {
      listener.release();
    }
  }

  #addSubscriber(streamId: string, subscriber: Subscriber): void {
    let subscribers = this.#subscribers.get(streamId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribers.set(streamId, subscribers);
    }
    subscribers.add(subscriber);
  }

  #removeSubscriber(streamId: string, subscriber: Subscriber): void {
    const subscribers = this.#subscribers.get(streamId);
    if (!subscribers) return;
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      this.#subscribers.delete(streamId);
    }
  }
}

class ChangeQueue<T> {
  #values: T[] = [];
  #waiters = new Set<{
    resolve: (value: T | undefined) => void;
    reject: (error: unknown) => void;
  }>();
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter.resolve(value);
      return;
    }
    this.#values.push(value);
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#values = [];
    for (const waiter of this.#waiters) {
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values = [];
    for (const waiter of this.#waiters) {
      waiter.resolve(undefined);
    }
    this.#waiters.clear();
  }

  async next(signal: AbortSignal): Promise<T | undefined> {
    if (this.#error) throw this.#error;
    if (this.#closed || signal.aborted) return undefined;
    if (this.#values.length > 0) {
      return this.#values.shift();
    }

    return new Promise<T | undefined>((resolve, reject) => {
      const waiter = { resolve, reject };
      const cleanup = () => {
        this.#waiters.delete(waiter);
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        resolve(undefined);
      };
      waiter.resolve = (value) => {
        cleanup();
        resolve(value);
      };
      waiter.reject = (error) => {
        cleanup();
        reject(error);
      };
      this.#waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function parsePayload(
  payload: string,
): { schema: string; streamId: string; kind: string } | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const candidate = parsed as {
      schema?: unknown;
      streamId?: unknown;
      kind?: unknown;
    };
    if (
      typeof candidate.schema !== 'string' ||
      typeof candidate.streamId !== 'string' ||
      typeof candidate.kind !== 'string'
    ) {
      return undefined;
    }
    return {
      schema: candidate.schema,
      streamId: candidate.streamId,
      kind: candidate.kind,
    };
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
