import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

import { SQLiteStore } from './sqlite.js';

const db = new DatabaseSync('./swarm.sqlite', {
  allowExtension: true,
});

db.loadExtension(sqliteVec.getLoadablePath());

export function nodeSQLite(dimension: number) {
  return new SQLiteStore(db, dimension);
}
