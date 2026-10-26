import { open } from './open.js';
import { SQLiteStore } from './sqlite.js';

export function nodeSQLite(dbName: string, dimension: number) {
  return new SQLiteStore(open(dbName), dimension);
}
