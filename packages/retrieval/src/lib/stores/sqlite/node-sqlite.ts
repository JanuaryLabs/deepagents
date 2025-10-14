import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

import { SQLiteStore } from './sqlite.js';

export function nodeSQLite(dbName: string, dimension: number) {
  const db = new DatabaseSync(dbName, {
    allowExtension: true,
  });

  db.loadExtension(sqliteVec.getLoadablePath());
  return new SQLiteStore(db, dimension);
}
