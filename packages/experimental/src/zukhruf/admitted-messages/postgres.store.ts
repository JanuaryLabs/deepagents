import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PostgresStoreDatabase,
  type PostgresTransaction,
  lockSchemaDDL,
} from '@deepagents/context';

import { admittedMessagesDDL } from './ddl.postgres.ts';
import { AdmittedMessageStore } from './store.ts';

const digestRowsSchema = z.array(z.object({ digest: z.string() })).max(1);

export interface PostgresAdmittedMessageStoreOptions {
  /** Borrowed: the host owns the pool and the store never ends it. */
  pool: Pool;
  /** PostgreSQL schema the table lives in. Default: `public`. */
  schema?: string;
}

/** PostgreSQL digests of admitted messages, which every worker on the database shares. */
export class PostgresAdmittedMessageStore extends AdmittedMessageStore {
  readonly #database: PostgresStoreDatabase;

  private constructor(database: PostgresStoreDatabase) {
    super();
    this.#database = database;
  }

  /** Opens the store: creates its table before it returns. */
  static async create(
    options: PostgresAdmittedMessageStoreOptions,
  ): Promise<PostgresAdmittedMessageStore> {
    const database = new PostgresStoreDatabase(options.pool, options.schema);
    await database.query(
      lockSchemaDDL(admittedMessagesDDL(database.schema), database.schema),
    );
    return new PostgresAdmittedMessageStore(database);
  }

  /** A view of this store whose reads and writes run inside `tx`. */
  bind(tx: PostgresTransaction): AdmittedMessageStore {
    return new PostgresAdmittedMessageStore(this.#database.bind(tx));
  }

  override async digestOf(turnId: string): Promise<string | undefined> {
    const result = await this.#database.query(
      `SELECT digest FROM ${this.#database.table('zukhruf_admitted_messages')}
        WHERE turn_id = $1`,
      [turnId],
    );
    return digestRowsSchema.parse(result.rows)[0]?.digest;
  }

  override async record(
    turnId: string,
    chatId: string,
    digest: string,
  ): Promise<void> {
    await this.#database.query(
      `INSERT INTO ${this.#database.table('zukhruf_admitted_messages')}
         (turn_id, chat_id, digest)
       VALUES ($1, $2, $3)`,
      [turnId, chatId, digest],
    );
  }

  override async forget(chatId: string): Promise<void> {
    await this.#database.query(
      `DELETE FROM ${this.#database.table('zukhruf_admitted_messages')}
        WHERE chat_id = $1`,
      [chatId],
    );
  }
}
