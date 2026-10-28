import { open } from './open.ts';
import { SQLiteStore } from './sqlite.ts';

export function nodeSQLite(dbName: string, dimension: number) {
  return new SQLiteStore(open(dbName), dimension);
}
