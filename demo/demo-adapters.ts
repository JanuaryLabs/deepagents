import { DatabaseSync } from 'node:sqlite';

import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

const DEFAULT_GAMEBOARD_DB =
  '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gameboard.sqlite';
const DEFAULT_GPU_DB =
  '/Users/ezzabuzaid/Desktop/January/text2sql/tools/gpu-database.sqlite';

function open(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  return new Sqlite({
    grounding: [tables(), info()],
    execute: (sql: string) => db.prepare(sql).all(),
  });
}

const adapters = {
  gameboard: open(
    process.env.TEXT2SQL_DEMO_GAMEBOARD_DB ?? DEFAULT_GAMEBOARD_DB,
  ),
  gpu_database: open(process.env.TEXT2SQL_DEMO_GPU_DB ?? DEFAULT_GPU_DB),
};

export default adapters;
