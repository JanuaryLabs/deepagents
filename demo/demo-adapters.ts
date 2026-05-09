import { DatabaseSync } from 'node:sqlite';

import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

function open(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  return new Sqlite({
    grounding: [tables(), info()],
    execute: (sql: string) => db.prepare(sql).all(),
  });
}

export default {
  gameboard: open('/data/gameboard.sqlite'),
  gpu_database: open('/data/gpu-database.sqlite'),
};
