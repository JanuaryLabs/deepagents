import { Declaration } from '@zukhruf/sqlite-drift';
import type { DatabaseSync } from 'node:sqlite';

import { statements } from './ddl.sqlite.ts';
import { DeletedConversationStore } from './store.ts';

const tables = new Declaration(statements, { rows: 'keep' });

/** SQLite tombstones of deleted chats, on the connection it is given. */
export class SqliteDeletedConversationStore extends DeletedConversationStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    super();
    this.#database = database;
    tables.apply(database);
  }

  override async has(chatId: string): Promise<boolean> {
    return (
      this.#database
        .prepare(
          'SELECT 1 FROM zukhruf_deleted_conversations WHERE chat_id = ?',
        )
        .get(chatId) !== undefined
    );
  }

  override async add(chatId: string, deletedAt: number): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO zukhruf_deleted_conversations (chat_id, deleted_at)
         VALUES (?, ?) ON CONFLICT (chat_id) DO NOTHING`,
      )
      .run(chatId, deletedAt);
  }
}
