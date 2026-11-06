import { open } from '@zukhruf/sqlite-open';

import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

const db = open(':memory:');
db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
db.exec(`INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');`);

const mem = new Sqlite({
  execute: (sql) => db.prepare(sql).all(),
  grounding: [tables(), info()],
});

export default { mem };
