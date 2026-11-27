import { Declaration } from '@zukhruf/sqlite-drift';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { statements } from './ddl.sqlite.ts';
import { AdmittedMessageStore } from './store.ts';

const tables = new Declaration(statements, { rows: 'keep' });

const digestRowSchema = z.object({ digest: z.string() }).optional();

/** SQLite digests of admitted messages, on the connection it is given. */
export class SqliteAdmittedMessageStore extends AdmittedMessageStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    super();
    this.#database = database;
    tables.apply(database);
  }

  override async digestOf(turnId: string): Promise<string | undefined> {
    return digestRowSchema.parse(
      this.#database
        .prepare(
          'SELECT digest FROM zukhruf_admitted_messages WHERE turn_id = ?',
        )
        .get(turnId),
    )?.digest;
  }

  override async record(
    turnId: string,
    chatId: string,
    digest: string,
  ): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO zukhruf_admitted_messages (turn_id, chat_id, digest)
         VALUES (?, ?, ?)`,
      )
      .run(turnId, chatId, digest);
  }

  override async forget(chatId: string): Promise<void> {
    this.#database
      .prepare('DELETE FROM zukhruf_admitted_messages WHERE chat_id = ?')
      .run(chatId);
  }
}
