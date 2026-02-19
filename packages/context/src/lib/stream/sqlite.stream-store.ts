import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import STREAM_DDL from './ddl.stream.sqlite.sql';
import type {
  StreamChunkData,
  StreamData,
  StreamStatus,
} from './stream-store.ts';
import { StreamStore } from './stream-store.ts';

export class SqliteStreamStore extends StreamStore {
  #db: DatabaseSync;
  #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
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

  async updateStreamStatus(
    streamId: string,
    status: StreamStatus,
    options?: { error?: string },
  ): Promise<void> {
    const now = Date.now();
    switch (status) {
      case 'running':
        this.#stmt(
          'UPDATE streams SET status = ?, startedAt = ? WHERE id = ?',
        ).run(status, now, streamId);
        break;
      case 'completed':
        this.#stmt(
          'UPDATE streams SET status = ?, finishedAt = ? WHERE id = ?',
        ).run(status, now, streamId);
        break;
      case 'failed':
        this.#stmt(
          'UPDATE streams SET status = ?, finishedAt = ?, error = ? WHERE id = ?',
        ).run(status, now, options?.error ?? null, streamId);
        break;
      case 'cancelled':
        this.#stmt(
          'UPDATE streams SET status = ?, cancelRequestedAt = ?, finishedAt = ? WHERE id = ?',
        ).run(status, now, now, streamId);
        break;
      default:
        this.#stmt('UPDATE streams SET status = ? WHERE id = ?').run(
          status,
          streamId,
        );
    }
  }

  async appendChunks(chunks: StreamChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
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
      data: JSON.parse(row.data),
      createdAt: row.createdAt,
    }));
  }

  async deleteStream(streamId: string): Promise<void> {
    this.#stmt('DELETE FROM streams WHERE id = ?').run(streamId);
  }
}
