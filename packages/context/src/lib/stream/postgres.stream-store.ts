import { createRequire } from 'node:module';
import type { Pool, PoolClient, PoolConfig } from 'pg';

import { postgresStreamDDL } from './ddl.stream.postgres.ts';
import type {
  ListStreamIdsOptions,
  StreamChunkData,
  StreamData,
  StreamStatus,
} from './stream-store.ts';
import { StreamStore } from './stream-store.ts';

export interface PostgresStreamStoreOptions {
  pool: Pool | PoolConfig | string;
  schema?: string;
}

type StreamRow = {
  id: string;
  status: StreamStatus;
  created_at: string | number;
  started_at: string | number | null;
  finished_at: string | number | null;
  cancel_requested_at: string | number | null;
  error: string | null;
};

type StreamChunkRow = {
  stream_id: string;
  seq: number;
  data: unknown;
  created_at: string | number;
};

export class PostgresStreamStore extends StreamStore {
  #pool: Pool;
  #schema: string;
  #ownsPool: boolean;
  #isInitialized = false;
  #isClosed = false;

  constructor(options: PostgresStreamStoreOptions) {
    super();
    const schema = options.schema ?? 'public';
    assertIdentifier(schema, 'schema');
    this.#schema = schema;

    const pg = PostgresStreamStore.#requirePg();
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
        'PostgresStreamStore requires the "pg" package. Install it with: npm install pg',
      );
    }
  }

  #t(name: string): string {
    return `"${this.#schema}"."${name}"`;
  }

  async initialize(): Promise<void> {
    await this.#pool.query(postgresStreamDDL(this.#schema));
    this.#isInitialized = true;
  }

  async close(): Promise<void> {
    if (this.#isClosed) return;
    this.#isClosed = true;
    if (this.#ownsPool) {
      await this.#pool.end();
    }
  }

  #ensureInitialized(): void {
    if (!this.#isInitialized) {
      throw new Error(
        'PostgresStreamStore not initialized. Call await store.initialize() after construction.',
      );
    }
  }

  async #query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    this.#ensureInitialized();
    const result = await this.#pool.query(sql, params);
    return result.rows as T[];
  }

  async #useTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#ensureInitialized();
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createStream(stream: StreamData): Promise<void> {
    await this.#query(
      `INSERT INTO ${this.#t('streams')}
       (id, status, created_at, started_at, finished_at, cancel_requested_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      streamParams(stream),
    );
  }

  async upsertStream(
    stream: StreamData,
  ): Promise<{ stream: StreamData; created: boolean }> {
    const rows = await this.#query<StreamRow>(
      `INSERT INTO ${this.#t('streams')}
       (id, status, created_at, started_at, finished_at, cancel_requested_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO NOTHING
       RETURNING *`,
      streamParams(stream),
    );

    if (rows[0]) {
      return { stream: rowToStream(rows[0]), created: true };
    }

    const existing = await this.getStream(stream.id);
    if (!existing) {
      throw new Error(
        `Stream "${stream.id}" disappeared between upsert and fetch`,
      );
    }
    return { stream: existing, created: false };
  }

  async getStream(streamId: string): Promise<StreamData | undefined> {
    const rows = await this.#query<StreamRow>(
      `SELECT * FROM ${this.#t('streams')} WHERE id = $1`,
      [streamId],
    );
    return rows[0] ? rowToStream(rows[0]) : undefined;
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus | undefined> {
    const rows = await this.#query<{ status: StreamStatus }>(
      `SELECT status FROM ${this.#t('streams')} WHERE id = $1`,
      [streamId],
    );
    return rows[0]?.status;
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    const params: unknown[] = [];
    let sql = `SELECT id FROM ${this.#t('streams')}`;

    if (options?.status) {
      params.push(options.status);
      sql += ` WHERE status = $${params.length}`;
    }

    sql += ' ORDER BY created_at ASC, id ASC';

    const rows = await this.#query<{ id: string }>(sql, params);
    return rows.map((row) => row.id);
  }

  async updateStreamStatus(
    streamId: string,
    status: StreamStatus,
    options?: { error?: string },
  ): Promise<void> {
    const now = Date.now();
    switch (status) {
      case 'running':
        await this.#query(
          `UPDATE ${this.#t('streams')}
           SET status = $1, started_at = $2
           WHERE id = $3`,
          [status, now, streamId],
        );
        break;
      case 'completed':
        await this.#query(
          `UPDATE ${this.#t('streams')}
           SET status = $1, finished_at = $2
           WHERE id = $3`,
          [status, now, streamId],
        );
        break;
      case 'failed':
        await this.#query(
          `UPDATE ${this.#t('streams')}
           SET status = $1, finished_at = $2, error = $3
           WHERE id = $4`,
          [status, now, options?.error ?? null, streamId],
        );
        break;
      case 'cancelled':
        await this.#query(
          `UPDATE ${this.#t('streams')}
           SET status = $1, cancel_requested_at = $2, finished_at = $3
           WHERE id = $4`,
          [status, now, now, streamId],
        );
        break;
      default:
        await this.#query(
          `UPDATE ${this.#t('streams')}
           SET status = $1
           WHERE id = $2`,
          [status, streamId],
        );
    }
  }

  async appendChunks(chunks: StreamChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const rows = chunks.map((chunk) => ({
      stream_id: chunk.streamId,
      seq: chunk.seq,
      data: chunk.data,
      created_at: chunk.createdAt,
    }));

    await this.#query(
      `INSERT INTO ${this.#t('stream_chunks')} (stream_id, seq, data, created_at)
       SELECT stream_id, seq, data, created_at
       FROM jsonb_to_recordset($1::jsonb)
         AS rows(stream_id TEXT, seq INTEGER, data JSONB, created_at BIGINT)`,
      [JSON.stringify(rows)],
    );
  }

  async getChunks(
    streamId: string,
    fromSeq?: number,
    limit?: number,
  ): Promise<StreamChunkData[]> {
    const params: unknown[] = [streamId];
    let sql = `SELECT * FROM ${this.#t('stream_chunks')} WHERE stream_id = $1`;

    if (fromSeq !== undefined) {
      params.push(fromSeq);
      sql += ` AND seq >= $${params.length}`;
    }

    sql += ' ORDER BY seq ASC';

    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const rows = await this.#query<StreamChunkRow>(sql, params);
    return rows.map((row) => ({
      streamId: row.stream_id,
      seq: row.seq,
      data: row.data,
      createdAt: toNumber(row.created_at),
    }));
  }

  async deleteStream(streamId: string): Promise<void> {
    await this.#query(`DELETE FROM ${this.#t('streams')} WHERE id = $1`, [
      streamId,
    ]);
  }

  async reopenStream(streamId: string): Promise<StreamData> {
    return this.#useTransaction(async (client) => {
      const result = await client.query<StreamRow>(
        `SELECT * FROM ${this.#t('streams')} WHERE id = $1 FOR UPDATE`,
        [streamId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`Stream "${streamId}" not found`);
      }
      if (!isTerminal(row.status)) {
        throw new Error(
          `Cannot reopen stream "${streamId}" with status "${row.status}". Only terminal streams can be reopened.`,
        );
      }

      await client.query(`DELETE FROM ${this.#t('streams')} WHERE id = $1`, [
        streamId,
      ]);

      const now = Date.now();
      const stream: StreamData = {
        id: streamId,
        status: 'queued',
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        error: null,
      };

      await client.query(
        `INSERT INTO ${this.#t('streams')}
         (id, status, created_at, started_at, finished_at, cancel_requested_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        streamParams(stream),
      );

      return stream;
    });
  }
}

function streamParams(stream: StreamData): unknown[] {
  return [
    stream.id,
    stream.status,
    stream.createdAt,
    stream.startedAt,
    stream.finishedAt,
    stream.cancelRequestedAt,
    stream.error,
  ];
}

function rowToStream(row: StreamRow): StreamData {
  return {
    id: row.id,
    status: row.status,
    createdAt: toNumber(row.created_at),
    startedAt: toNullableNumber(row.started_at),
    finishedAt: toNullableNumber(row.finished_at),
    cancelRequestedAt: toNullableNumber(row.cancel_requested_at),
    error: row.error,
  };
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: string | number | null): number | null {
  return value == null ? null : toNumber(value);
}

function isTerminal(status: StreamStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z_]\w*$/.test(value)) {
    throw new Error(`Invalid ${label} name: "${value}"`);
  }
}
