import { transaction } from '@zukhruf/sqlite-transaction';
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLTagStore,
} from 'node:sqlite';
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
  #sql: SQLTagStore;

  close(): void {
    if (!this.#db.isOpen) return;
    this.#db.close();
  }

  constructor(pathOrDb: string | DatabaseSync) {
    super();
    this.#db =
      typeof pathOrDb === 'string' ? new DatabaseSync(pathOrDb) : pathOrDb;
    this.#db.exec(STREAM_DDL);
    this.#sql = this.#db.createTagStore();
  }

  async createStream(stream: StreamData): Promise<void> {
    this.#sql
      .run`INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
       VALUES (${stream.id}, ${stream.status}, ${stream.createdAt}, ${stream.startedAt}, ${stream.finishedAt}, ${stream.cancelRequestedAt}, ${stream.error})`;
  }

  async upsertStream(
    stream: StreamData,
  ): Promise<{ stream: StreamData; created: boolean }> {
    const created = streamRow.optional().parse(
      this.#sql
        .get`INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
       VALUES (${stream.id}, ${stream.status}, ${stream.createdAt}, ${stream.startedAt}, ${stream.finishedAt}, ${stream.cancelRequestedAt}, ${stream.error})
       ON CONFLICT(id) DO NOTHING
       RETURNING *`,
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
      .parse(this.#sql.get`SELECT * FROM streams WHERE id = ${streamId}`);
  }

  async getStreamStatus(streamId: string): Promise<StreamStatus | undefined> {
    const row = statusRow
      .optional()
      .parse(this.#sql.get`SELECT status FROM streams WHERE id = ${streamId}`);
    return row?.status;
  }

  async listStreamIds(options?: ListStreamIdsOptions): Promise<string[]> {
    const rows = z
      .array(idRow)
      .parse(
        options?.status
          ? this.#sql
              .all`SELECT id FROM streams WHERE status = ${options.status} ORDER BY createdAt ASC, id ASC`
          : this.#sql
              .all`SELECT id FROM streams ORDER BY createdAt ASC, id ASC`,
      );
    return rows.map((row) => row.id);
  }

  async updateStream(
    streamId: string,
    update: StreamUpdater,
  ): Promise<StreamUpdateResult> {
    return transaction(
      this.#db,
      () => {
        const stream = streamRow
          .optional()
          .parse(this.#sql.get`SELECT * FROM streams WHERE id = ${streamId}`);
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
        if (updates.startedAt !== undefined)
          set('startedAt', updates.startedAt);
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
          this.#db
            .prepare(
              `UPDATE streams SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`,
            )
            .get(...params),
        );
        return { stream: next, updated: true };
      },
      { mode: 'immediate' },
    );
  }

  async updateStreamStatus(
    streamId: string,
    status: StreamStatus,
    options?: { error?: string },
  ): Promise<void> {
    const now = Date.now();
    switch (status) {
      case 'running':
        this.#sql.run`UPDATE streams SET status = ${status}, startedAt = ${now}
            WHERE id = ${streamId} AND status = 'queued'`;
        break;
      case 'completed':
        this.#sql.run`UPDATE streams SET status = ${status}, finishedAt = ${now}
            WHERE id = ${streamId} AND status IN ('queued', 'running')`;
        break;
      case 'failed':
        this.#sql
          .run`UPDATE streams SET status = ${status}, finishedAt = ${now}, error = ${options?.error ?? null}
            WHERE id = ${streamId} AND status IN ('queued', 'running')`;
        break;
      case 'cancelled':
        this.#sql
          .run`UPDATE streams SET status = ${status}, cancelRequestedAt = ${now}, finishedAt = ${now}
            WHERE id = ${streamId} AND status IN ('queued', 'running')`;
        break;
      default:
        this.#sql.run`UPDATE streams SET status = ${status}
            WHERE id = ${streamId} AND status = 'queued'`;
    }
  }

  async appendChunks(chunks: StreamChunkData[]): Promise<void> {
    if (chunks.length === 0) return;
    const failures = collectStreamFailures(chunks);
    transaction(
      this.#db,
      () => {
        for (const chunk of chunks) {
          this.#sql
            .run`INSERT INTO stream_chunks (streamId, seq, data, createdAt)
           VALUES (${chunk.streamId}, ${chunk.seq}, ${JSON.stringify(chunk.data)}, ${chunk.createdAt})`;
        }
        const failedAt = Date.now();
        for (const failure of failures) {
          const result = this.#sql
            .run`UPDATE streams SET status = 'failed', finishedAt = ${failedAt}, error = ${failure.error}
            WHERE id = ${failure.streamId} AND status IN ('queued', 'running')`;
          if (result.changes !== 1) {
            const existing = this.#sql
              .get`SELECT id FROM streams WHERE id = ${failure.streamId}`;
            if (!existing) {
              throw new Error(`Stream "${failure.streamId}" not found`);
            }
          }
        }
      },
      { mode: 'immediate' },
    );
  }

  async getChunks(
    streamId: string,
    fromSeq?: number,
    limit?: number,
  ): Promise<StreamChunkData[]> {
    const rows = z
      .array(chunkRow)
      .parse(this.#chunkRows(streamId, fromSeq, limit));

    return Promise.all(
      rows.map(async (row): Promise<StreamChunkData> => ({
        streamId: row.streamId,
        seq: row.seq,
        data: await toStreamPart(parseJson(row.data)),
        createdAt: row.createdAt,
      })),
    );
  }

  #chunkRows(streamId: string, fromSeq?: number, limit?: number) {
    if (fromSeq !== undefined && limit !== undefined) {
      return this.#sql
        .all`SELECT * FROM stream_chunks WHERE streamId = ${streamId} AND seq >= ${fromSeq} ORDER BY seq ASC LIMIT ${limit}`;
    }
    if (fromSeq !== undefined) {
      return this.#sql
        .all`SELECT * FROM stream_chunks WHERE streamId = ${streamId} AND seq >= ${fromSeq} ORDER BY seq ASC`;
    }
    if (limit !== undefined) {
      return this.#sql
        .all`SELECT * FROM stream_chunks WHERE streamId = ${streamId} ORDER BY seq ASC LIMIT ${limit}`;
    }
    return this.#sql
      .all`SELECT * FROM stream_chunks WHERE streamId = ${streamId} ORDER BY seq ASC`;
  }

  async deleteStream(streamId: string): Promise<void> {
    this.#sql.run`DELETE FROM streams WHERE id = ${streamId}`;
  }

  async reopenStream(streamId: string): Promise<StreamData> {
    return transaction(
      this.#db,
      () => {
        const row = statusRow
          .optional()
          .parse(this.#sql.get`SELECT * FROM streams WHERE id = ${streamId}`);

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

        this.#sql.run`DELETE FROM streams WHERE id = ${streamId}`;
        const now = Date.now();
        this.#sql
          .run`INSERT INTO streams (id, status, createdAt, startedAt, finishedAt, cancelRequestedAt, error)
         VALUES (${streamId}, 'queued', ${now}, NULL, NULL, NULL, NULL)`;

        return {
          id: streamId,
          status: 'queued',
          createdAt: now,
          startedAt: null,
          finishedAt: null,
          cancelRequestedAt: null,
          error: null,
        };
      },
      { mode: 'immediate' },
    );
  }
}
