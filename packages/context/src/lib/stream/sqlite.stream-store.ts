import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

import { parseJson } from '../store/columns.ts';
import STREAM_DDL from './ddl.stream.sqlite.sql';
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

// Row shapes as node:sqlite returns them for ddl.stream.sqlite.sql.

const streamRow = z.object({
  id: z.string(),
  status: streamStatus,
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  cancelRequestedAt: z.number().nullable(),
  error: z.string().nullable(),
}) satisfies z.ZodType<StreamData>;

const statusRow = z.object({ status: streamStatus });

const idRow = z.object({ id: z.string() });

const chunkRow = z.object({
  streamId: z.string(),
  seq: z.number(),
  data: z.string(),
  createdAt: z.number(),
});

export class SqliteStreamStore extends StreamStore {
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #closed = false;

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    this.#db.close();
  }

  constructor(pathOrDb: string | DatabaseSync) {
    super();
    this.#db =
      typeof pathOrDb === 'string' ? new DatabaseSync(pathOrDb) : pathOrDb;
    this.#db.exec(STREAM_DDL);
  }

  async createStream(stream: StreamData): Promise<void> {
    this.#stmt(
      `INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      stream.id,
      stream.status,
      stream.createdAt,
      stream.startedAt,
      stream.finishedAt,
      stream.cancelRequestedAt,
      stream.error,
    );
  }

  async upsertStream(
    stream: StreamData,
  ): Promise<{ stream: StreamData; created: boolean }> {
    const created = streamRow.optional().parse(
      this.#stmt(
        `INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING
       RETURNING *`,
      ).get(
        stream.id,
        stream.status,
        stream.createdAt,
        stream.startedAt,
        stream.finishedAt,
        stream.cancelRequestedAt,
        stream.error,
      ),
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
    return streamRow
      .optional()
      .parse(this.#stmt('SELECT * FROM streams WHERE id = ?').get(streamId));
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus | undefined> {
    const row = statusRow
      .optional()
      .parse(
        this.#stmt('SELECT status FROM streams WHERE id = ?').get(streamId),
      );
    return row?.status;
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    let sql = 'SELECT id FROM streams';
    const params: SQLInputValue[] = [];

    if (options?.status) {
      sql += ' WHERE status = ?';
      params.push(options.status);
    }

    sql += ' ORDER BY createdAt ASC, id ASC';

    const rows = z.array(idRow).parse(this.#stmt(sql).all(...params));
    return rows.map((row) => row.id);
  }

  async updateStream(
    streamId: string,
    update: StreamUpdater,
  ): Promise<StreamUpdateResult> {
    return this.#transaction(() => {
      const stream = streamRow
        .optional()
        .parse(this.#stmt('SELECT * FROM streams WHERE id = ?').get(streamId));
      if (!stream) {
        throw new Error(`updateStream: stream "${streamId}" not found`);
      }

      const updates = update(stream);
      if (updates === undefined) return { stream, updated: false };

      const setClauses: string[] = [];
      const params: SQLInputValue[] = [];
      const set = (column: string, value: SQLInputValue) => {
        setClauses.push(`${column} = ?`);
        params.push(value);
      };

      if (updates.status !== undefined) set('status', updates.status);
      if (updates.startedAt !== undefined) set('startedAt', updates.startedAt);
      if (updates.finishedAt !== undefined) {
        set('finishedAt', updates.finishedAt);
      }
      if (updates.cancelRequestedAt !== undefined) {
        set('cancelRequestedAt', updates.cancelRequestedAt);
      }
      if (updates.error !== undefined) set('error', updates.error);
      if (setClauses.length === 0) return { stream, updated: false };

      params.push(streamId);
      const next = streamRow.parse(
        this.#stmt(
          `UPDATE streams SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
        ).get(...params),
      );
      return { stream: next, updated: true };
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
        this.#stmt(
          `UPDATE streams SET status = ?, startedAt = ?
            WHERE id = ? AND status = 'queued'`,
        ).run(status, now, streamId);
        break;
      case 'completed':
        this.#stmt(
          `UPDATE streams SET status = ?, finishedAt = ?
            WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(status, now, streamId);
        break;
      case 'failed':
        this.#stmt(
          `UPDATE streams SET status = ?, finishedAt = ?, error = ?
            WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(status, now, options?.error ?? null, streamId);
        break;
      case 'cancelled':
        this.#stmt(
          `UPDATE streams SET status = ?, cancelRequestedAt = ?, finishedAt = ?
            WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(status, now, now, streamId);
        break;
      default:
        this.#stmt(
          `UPDATE streams SET status = ?
            WHERE id = ? AND status = 'queued'`,
        ).run(status, streamId);
    }
  }

  async appendChunks(chunks: StreamChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const failures = collectStreamFailures(chunks);
    this.#db.exec('BEGIN TRANSACTION');
    try {
      for (const chunk of chunks) {
        this.#stmt(
          `INSERT INTO stream_chunks (streamId, seq, data, createdAt)
           VALUES (?, ?, ?, ?)`,
        ).run(
          chunk.streamId,
          chunk.seq,
          JSON.stringify(chunk.data),
          chunk.createdAt,
        );
      }
      const failedAt = Date.now();
      for (const failure of failures) {
        const result = this.#stmt(
          `UPDATE streams SET status = ?, finishedAt = ?, error = ?
            WHERE id = ? AND status IN ('queued', 'running')`,
        ).run('failed', failedAt, failure.error, failure.streamId);
        if (result.changes !== 1) {
          const existing = this.#stmt(
            'SELECT id FROM streams WHERE id = ?',
          ).get(failure.streamId);
          if (!existing) {
            throw new Error(`Stream "${failure.streamId}" not found`);
          }
        }
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async getChunks(
    streamId: string,
    fromSeq?: number,
    limit?: number,
  ): Promise<StreamChunkData[]> {
    let sql = 'SELECT * FROM stream_chunks WHERE streamId = ?';
    const params: SQLInputValue[] = [streamId];

    if (fromSeq !== undefined) {
      sql += ' AND seq >= ?';
      params.push(fromSeq);
    }

    sql += ' ORDER BY seq ASC';

    if (limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = z.array(chunkRow).parse(this.#stmt(sql).all(...params));

    return Promise.all(
      rows.map(async (row): Promise<StreamChunkData> => ({
        streamId: row.streamId,
        seq: row.seq,
        data: await toStreamPart(parseJson(row.data)),
        createdAt: row.createdAt,
      })),
    );
  }

  async deleteStream(streamId: string): Promise<void> {
    this.#stmt('DELETE FROM streams WHERE id = ?').run(streamId);
  }

  async reopenStream(streamId: string): Promise<StreamData> {
    return this.#transaction(() => {
      const row = statusRow
        .optional()
        .parse(this.#stmt('SELECT * FROM streams WHERE id = ?').get(streamId));

      if (!row) {
        throw new Error(`Stream "${streamId}" not found`);
      }
      if (
        row.status !== 'completed' &&
        row.status !== 'failed' &&
        row.status !== 'cancelled'
      ) {
        throw new Error(
          `Cannot reopen stream "${streamId}" with status "${row.status}". Only terminal streams can be reopened.`,
        );
      }

      this.#stmt('DELETE FROM streams WHERE id = ?').run(streamId);
      const now = Date.now();
      this.#stmt(
        `INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(streamId, 'queued', now, null, null, null, null);

      return {
        id: streamId,
        status: 'queued',
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        error: null,
      };
    });
  }

  #transaction<T>(callback: () => T): T {
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = callback();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
