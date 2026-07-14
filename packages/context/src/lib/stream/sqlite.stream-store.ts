import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import STREAM_DDL from './ddl.stream.sqlite.sql';
import type {
  ListStreamIdsOptions,
  StreamChunkData,
  StreamData,
  StreamStatus,
  StreamUpdateResult,
  StreamUpdater,
} from './stream-store.ts';
import { collectStreamFailures } from './stream-store.ts';
import { StreamStore } from './stream-store.ts';

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
    const row = this.#stmt(
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
    ) as
      | {
          id: string;
          status: StreamStatus;
          createdAt: number;
          startedAt: number | null;
          finishedAt: number | null;
          cancelRequestedAt: number | null;
          error: string | null;
        }
      | undefined;

    if (row) {
      return {
        stream: {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          cancelRequestedAt: row.cancelRequestedAt,
          error: row.error,
        },
        created: true,
      };
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
    const row = this.#stmt('SELECT * FROM streams WHERE id = ?').get(
      streamId,
    ) as
      | {
          id: string;
          status: StreamStatus;
          createdAt: number;
          startedAt: number | null;
          finishedAt: number | null;
          cancelRequestedAt: number | null;
          error: string | null;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      cancelRequestedAt: row.cancelRequestedAt,
      error: row.error,
    };
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus | undefined> {
    const row = this.#stmt('SELECT status FROM streams WHERE id = ?').get(
      streamId,
    ) as
      | {
          status: StreamStatus;
        }
      | undefined;
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

    const rows = this.#stmt(sql).all(...params) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async updateStream(
    streamId: string,
    update: StreamUpdater,
  ): Promise<StreamUpdateResult> {
    return this.#transaction(() => {
      const current = this.#stmt('SELECT * FROM streams WHERE id = ?').get(
        streamId,
      ) as
        | {
            id: string;
            status: StreamStatus;
            createdAt: number;
            startedAt: number | null;
            finishedAt: number | null;
            cancelRequestedAt: number | null;
            error: string | null;
          }
        | undefined;
      if (!current) {
        throw new Error(`updateStream: stream "${streamId}" not found`);
      }

      const stream: StreamData = { ...current };
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
      const next = this.#stmt(
        `UPDATE streams SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
      ).get(...params) as unknown as typeof current;
      return { stream: { ...next }, updated: true };
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

    const rows = this.#stmt(sql).all(...params) as {
      streamId: string;
      seq: number;
      data: string;
      createdAt: number;
    }[];

    return rows.map((row) => ({
      streamId: row.streamId,
      seq: row.seq,
      data: JSON.parse(row.data) as StreamChunkData['data'],
      createdAt: row.createdAt,
    }));
  }

  async deleteStream(streamId: string): Promise<void> {
    this.#stmt('DELETE FROM streams WHERE id = ?').run(streamId);
  }

  async reopenStream(streamId: string): Promise<StreamData> {
    return this.#transaction(() => {
      const row = this.#stmt('SELECT * FROM streams WHERE id = ?').get(
        streamId,
      ) as
        | {
            id: string;
            status: StreamStatus;
          }
        | undefined;

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
