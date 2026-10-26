import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

// The store's statements use the vec0 module, so every connection that runs
// them, the dev database of the declaration included, loads sqlite-vec.
export function open(path: string) {
  const db = new DatabaseSync(path, { allowExtension: true });
  db.loadExtension(sqliteVec.getLoadablePath());
  return db;
}
