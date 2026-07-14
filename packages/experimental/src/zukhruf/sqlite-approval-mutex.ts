import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ApprovalMutex } from './approval-mutex.ts';

/**
 * Cross-process approval mutex backed by a dedicated SQLite database.
 *
 * SQLite write locks are database-wide, so one file serializes all approval
 * transitions that use it. Do not use the ContextStore database file: the
 * protected operation must be able to persist the assistant message while this
 * transaction is open.
 */
export class SqliteApprovalMutex extends ApprovalMutex implements Disposable {
  static readonly #tails = new Map<string, Promise<void>>();

  readonly #db: DatabaseSync;
  readonly #coordinationKey: string;

  constructor(path: string) {
    super();
    this.#coordinationKey =
      path === ':memory:' ? crypto.randomUUID() : resolve(path);
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS approval_mutex (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        conversationId TEXT NOT NULL,
        touchedAt INTEGER NOT NULL
      );
    `);
  }

  async runExclusive<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.#acquireLocalGate();
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db
          .prepare(
            `INSERT INTO approval_mutex (id, conversationId, touchedAt)
             VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               conversationId = excluded.conversationId,
               touchedAt = excluded.touchedAt`,
          )
          .run(conversationId, Date.now());
        const result = await operation();
        this.#db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.#db.exec('ROLLBACK');
        } catch {
          // Preserve the operation error if SQLite already ended the transaction.
        }
        throw error;
      }
    } finally {
      release();
    }
  }

  close(): void {
    this.#db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  async #acquireLocalGate(): Promise<() => void> {
    const previous =
      SqliteApprovalMutex.#tails.get(this.#coordinationKey) ??
      Promise.resolve();
    const gate = Promise.withResolvers<void>();
    const tail = previous.then(() => gate.promise);
    SqliteApprovalMutex.#tails.set(this.#coordinationKey, tail);
    await previous;
    return () => {
      gate.resolve();
      if (SqliteApprovalMutex.#tails.get(this.#coordinationKey) === tail) {
        SqliteApprovalMutex.#tails.delete(this.#coordinationKey);
      }
    };
  }
}
