import type { Pool } from 'pg';
import { z } from 'zod';

import {
  PostgresStoreDatabase,
  type PostgresTransaction,
  lockSchemaDDL,
} from '@deepagents/context';

import { deletedConversationsDDL } from './ddl.postgres.ts';
import { DeletedConversationStore } from './store.ts';

const existsRowsSchema = z.tuple([z.object({ exists: z.boolean() })]);

export interface PostgresDeletedConversationStoreOptions {
  /** Borrowed: the host owns the pool and the store never ends it. */
  pool: Pool;
  /** PostgreSQL schema the table lives in. Default: `public`. */
  schema?: string;
}

/** PostgreSQL tombstones of deleted chats, which every worker on the database shares. */
export class PostgresDeletedConversationStore extends DeletedConversationStore {
  readonly #database: PostgresStoreDatabase;

  private constructor(database: PostgresStoreDatabase) {
    super();
    this.#database = database;
  }

  /** Opens the store: creates its table before it returns. */
  static async create(
    options: PostgresDeletedConversationStoreOptions,
  ): Promise<PostgresDeletedConversationStore> {
    const database = new PostgresStoreDatabase(options.pool, options.schema);
    await database.query(
      lockSchemaDDL(deletedConversationsDDL(database.schema), database.schema),
    );
    return new PostgresDeletedConversationStore(database);
  }

  /** A view of this store whose reads and writes run inside `tx`. */
  bind(tx: PostgresTransaction): DeletedConversationStore {
    return new PostgresDeletedConversationStore(this.#database.bind(tx));
  }

  override async has(chatId: string): Promise<boolean> {
    const result = await this.#database.query(
      `SELECT EXISTS (
         SELECT 1 FROM ${this.#database.table('zukhruf_deleted_conversations')}
          WHERE chat_id = $1)`,
      [chatId],
    );
    return existsRowsSchema.parse(result.rows)[0].exists;
  }

  override async add(chatId: string, deletedAt: number): Promise<void> {
    await this.#database.query(
      `INSERT INTO ${this.#database.table('zukhruf_deleted_conversations')}
         (chat_id, deleted_at)
       VALUES ($1, $2)
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, deletedAt],
    );
  }
}
