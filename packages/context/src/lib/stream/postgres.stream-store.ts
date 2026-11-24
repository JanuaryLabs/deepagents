import type { Pool } from 'pg';
import { z } from 'zod';

import { bigintColumn } from '../store/columns.ts';
import { lockSchemaDDL } from '../store/postgres-schema-lock.ts';
import { PostgresStoreDatabase } from '../store/postgres-store-database.ts';
import type { PostgresTransaction } from '../store/postgres-transaction.ts';
import { postgresStreamDDL } from './ddl.stream.postgres.ts';
import { streamStatus, toStreamPart } from './rows.ts';
import type {
  ListStreamIdsOptions,
  StreamChunkData,
  StreamData,
  StreamStatus,
  StreamUpdateResult,
  StreamUpdater,
} from './stream-store.ts';
import { StreamStore, collectStreamFailures } from './stream-store.ts';

export interface PostgresStreamStoreOptions {
  /** The host's pool; the store borrows it and never ends it. */
  pool: Pool;
  schema?: string;
}

// Row shapes as pg returns them for ddl.stream.postgres.ts: BIGINT arrives as
// a string (see bigintColumn), INTEGER as a number, JSONB parsed.

const storedStream = z
  .object({
    id: z.string(),
    status: streamStatus,
    created_at: bigintColumn,
    started_at: bigintColumn.nullable(),
    finished_at: bigintColumn.nullable(),
    cancel_requested_at: bigintColumn.nullable(),
    error: z.string().nullable(),
  })
  .transform((row): StreamData => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequestedAt: row.cancel_requested_at,
    error: row.error,
  }));

const statusRow = z.object({ status: streamStatus });

const idRow = z.object({ id: z.string() });

const chunkRow = z.object({
  stream_id: z.string(),
  seq: z.number(),
  data: z.unknown(),
  created_at: bigintColumn,
});

export class PostgresStreamStore extends StreamStore {
  readonly #database: PostgresStoreDatabase;

  private constructor(database: PostgresStoreDatabase) {
    super();
    this.#database = database;
  }

  /** Opens the store: creates its tables before it returns. */
  static async create(
    options: PostgresStreamStoreOptions,
  ): Promise<PostgresStreamStore> {
    const database = new PostgresStoreDatabase(options.pool, options.schema);
    await database.query(
      lockSchemaDDL(postgresStreamDDL(database.schema), database.schema),
    );
    return new PostgresStreamStore(database);
  }

  /** A view of this store whose reads and writes run inside `tx`. */
  bind(tx: PostgresTransaction): PostgresStreamStore {
    return new PostgresStreamStore(this.#database.bind(tx));
  }

  async createStream(stream: StreamData): Promise<void> {
    await this.#database.query(
      `INSERT INTO ${this.#database.table('streams')}
       (id, status, created_at, started_at, finished_at, cancel_requested_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      streamParams(stream),
    );
  }

  async upsertStream(
    stream: StreamData,
  ): Promise<{ stream: StreamData; created: boolean }> {
    const [created] = await this.#database.rows(
      storedStream,
      `INSERT INTO ${this.#database.table('streams')}
       (id, status, created_at, started_at, finished_at, cancel_requested_at, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO NOTHING
       RETURNING *`,
      streamParams(stream),
    );

    if (created) {
      return { stream: created, created: true };
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
    const [found] = await this.#database.rows(
      storedStream,
      `SELECT * FROM ${this.#database.table('streams')} WHERE id = $1`,
      [streamId],
    );
    return found;
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus | undefined> {
    const rows = await this.#database.rows(
      statusRow,
      `SELECT status FROM ${this.#database.table('streams')} WHERE id = $1`,
      [streamId],
    );
    return rows[0]?.status;
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    const params: unknown[] = [];
    const where: string[] = [];

    if (options?.status) {
      params.push(options.status);
      where.push(`status = $${params.length}`);
    }

    if (options?.prefix) {
      params.push(options.prefix);
      where.push(`starts_with(id, $${params.length})`);
    }

    let sql = `SELECT id FROM ${this.#database.table('streams')}`;
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at ASC, id ASC';

    const rows = await this.#database.rows(idRow, sql, params);
    return rows.map((row) => row.id);
  }

  async updateStream(
    streamId: string,
    update: StreamUpdater,
  ): Promise<StreamUpdateResult> {
    return this.#database.transaction(async (tx) => {
      const selected = await tx.query(
        `SELECT * FROM ${this.#database.table('streams')} WHERE id = $1 FOR UPDATE`,
        [streamId],
      );
      const stream = storedStream.optional().parse(selected.rows[0]);
      if (!stream) {
        throw new Error(`updateStream: stream "${streamId}" not found`);
      }

      const updates = update(stream);
      if (updates === undefined) return { stream, updated: false };

      const setClauses: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        params.push(value);
        setClauses.push(`${column} = $${params.length}`);
      };

      if (updates.status !== undefined) set('status', updates.status);
      if (updates.startedAt !== undefined) set('started_at', updates.startedAt);
      if (updates.finishedAt !== undefined) {
        set('finished_at', updates.finishedAt);
      }
      if (updates.cancelRequestedAt !== undefined) {
        set('cancel_requested_at', updates.cancelRequestedAt);
      }
      if (updates.error !== undefined) set('error', updates.error);
      if (setClauses.length === 0) return { stream, updated: false };

      params.push(streamId);
      const updated = await tx.query(
        `UPDATE ${this.#database.table('streams')}
            SET ${setClauses.join(', ')}
          WHERE id = $${params.length}
          RETURNING *`,
        params,
      );
      return { stream: storedStream.parse(updated.rows[0]), updated: true };
    });
  }

  async updateStreamStatus(
    streamId: string,
    status: StreamStatus,
    options?: { error?: string },
  ): Promise<void> {
    const now = Date.now();
    switch (status) {
      case 'running':
        await this.#database.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1, started_at = $2
           WHERE id = $3 AND status = 'queued'`,
          [status, now, streamId],
        );
        break;
      case 'completed':
        await this.#database.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1, finished_at = $2
           WHERE id = $3 AND status IN ('queued', 'running')`,
          [status, now, streamId],
        );
        break;
      case 'failed':
        await this.#database.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1, finished_at = $2, error = $3
           WHERE id = $4 AND status IN ('queued', 'running')`,
          [status, now, options?.error ?? null, streamId],
        );
        break;
      case 'cancelled':
        await this.#database.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1, cancel_requested_at = $2, finished_at = $3
           WHERE id = $4 AND status IN ('queued', 'running')`,
          [status, now, now, streamId],
        );
        break;
      default:
        await this.#database.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1
           WHERE id = $2 AND status = 'queued'`,
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
    const params = [JSON.stringify(rows)];
    const insertSql = `INSERT INTO ${this.#database.table('stream_chunks')} (stream_id, seq, data, created_at)
       SELECT stream_id, seq, data, created_at
       FROM jsonb_to_recordset($1::jsonb)
         AS rows(stream_id TEXT, seq INTEGER, data JSONB, created_at BIGINT)`;

    const failures = collectStreamFailures(chunks);
    if (failures.length === 0) {
      await this.#database.query(insertSql, params);
      return;
    }

    await this.#database.transaction(async (tx) => {
      await tx.query(insertSql, params);
      const failedAt = Date.now();
      for (const failure of failures) {
        const result = await tx.query(
          `UPDATE ${this.#database.table('streams')}
           SET status = $1, finished_at = $2, error = $3
           WHERE id = $4 AND status IN ('queued', 'running')`,
          ['failed', failedAt, failure.error, failure.streamId],
        );
        if (result.rowCount !== 1) {
          const existing = await tx.query(
            `SELECT id FROM ${this.#database.table('streams')} WHERE id = $1`,
            [failure.streamId],
          );
          if (existing.rowCount !== 1) {
            throw new Error(`Stream "${failure.streamId}" not found`);
          }
        }
      }
    });
  }

  async getChunks(
    streamId: string,
    fromSeq?: number,
    limit?: number,
  ): Promise<StreamChunkData[]> {
    const params: unknown[] = [streamId];
    let sql = `SELECT * FROM ${this.#database.table('stream_chunks')} WHERE stream_id = $1`;

    if (fromSeq !== undefined) {
      params.push(fromSeq);
      sql += ` AND seq >= $${params.length}`;
    }

    sql += ' ORDER BY seq ASC';

    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }

    const rows = await this.#database.rows(chunkRow, sql, params);
    return Promise.all(
      rows.map(async (row): Promise<StreamChunkData> => ({
        streamId: row.stream_id,
        seq: row.seq,
        data: await toStreamPart(row.data),
        createdAt: row.created_at,
      })),
    );
  }

  async deleteStream(streamId: string): Promise<void> {
    await this.#database.query(
      `DELETE FROM ${this.#database.table('streams')} WHERE id = $1`,
      [streamId],
    );
  }

  async reopenStream(streamId: string): Promise<StreamData> {
    return this.#database.transaction(async (tx) => {
      const result = await tx.query(
        `SELECT * FROM ${this.#database.table('streams')} WHERE id = $1 FOR UPDATE`,
        [streamId],
      );
      const row = statusRow.optional().parse(result.rows[0]);
      if (!row) {
        throw new Error(`Stream "${streamId}" not found`);
      }
      if (!isTerminal(row.status)) {
        throw new Error(
          `Cannot reopen stream "${streamId}" with status "${row.status}". Only terminal streams can be reopened.`,
        );
      }

      await tx.query(
        `DELETE FROM ${this.#database.table('streams')} WHERE id = $1`,
        [streamId],
      );

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

      await tx.query(
        `INSERT INTO ${this.#database.table('streams')}
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

function isTerminal(status: StreamStatus): boolean {
  return status !== 'queued' && status !== 'running';
}
