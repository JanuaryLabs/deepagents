import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';

import {
  PostgresTransaction,
  postgresTransaction,
} from './postgres-transaction.ts';

/**
 * Where a Postgres store reads and writes: its schema on the host's pool, or
 * on one open transaction once `bind` has narrowed it. A store holds one and
 * builds its `bind(tx)` view from `database.bind(tx)`.
 */
export class PostgresStoreDatabase {
  readonly schema: string;
  readonly #db: Pool | PostgresTransaction;

  constructor(db: Pool | PostgresTransaction, schema = 'public') {
    if (!/^[a-zA-Z_]\w*$/.test(schema)) {
      throw new Error(`Invalid schema name: "${schema}"`);
    }
    this.schema = schema;
    this.#db = db;
  }

  /** The same schema, read and written inside `tx`. */
  bind(tx: PostgresTransaction): PostgresStoreDatabase {
    return new PostgresStoreDatabase(tx, this.schema);
  }

  /** `name` qualified by the schema, quoted for SQL. */
  table(name: string): string {
    return `"${this.schema}"."${name}"`;
  }

  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    const db: Pick<PostgresTransaction, 'query'> = this.#db;
    return db.query<Row>(text, values);
  }

  async rows<Row extends z.ZodType>(
    row: Row,
    text: string,
    values?: unknown[],
  ): Promise<z.output<Row>[]> {
    return z.array(row).parse((await this.query(text, values)).rows);
  }

  /**
   * Runs `fn` in a transaction: its own on the pool, or a savepoint of the
   * transaction this database is bound to.
   */
  transaction<T>(fn: (tx: PostgresTransaction) => Promise<T>): Promise<T> {
    return postgresTransaction(this.#db, fn);
  }
}
