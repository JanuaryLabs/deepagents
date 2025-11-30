/* eslint-disable @nx/enforce-module-boundaries */
import { DatabaseSync } from 'node:sqlite';

import { Sqlite, type SqliteAdapterOptions } from '@deepagents/text2sql/sqlite';

/**
 * Create an in-memory sqlite database, apply DDL, and return a Sqlite adapter bound to it
 * along with the DatabaseSync instance for cleanup.
 */
export async function init_db(
  ddl: string | string[],
  options: Partial<SqliteAdapterOptions> = {},
) {
  const db = new DatabaseSync(':memory:');

  // enable foreign keys
  try {
    db.exec('PRAGMA foreign_keys = ON;');
  } catch {
    // ignore — best effort
  }

  if (Array.isArray(ddl)) {
    for (const stmt of ddl) {
      db.exec(stmt);
    }
  } else if (typeof ddl === 'string') {
    db.exec(ddl);
  }

  const adapter = new Sqlite({
    ...options,
    grounding: options.grounding ?? [],
    execute: options.execute ?? ((sql: string) => db.prepare(sql).all()),
  });
  return { adapter, db };
}
