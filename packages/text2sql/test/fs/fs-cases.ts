import { Postgres } from '@zukhruf/testing/postgres';
import { Sqlite } from '@zukhruf/testing/sqlite';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import { MssqlFs, PostgresFs, SqliteFs } from '@deepagents/text2sql';

/** A file system rooted at `/` over a fresh database; disposal closes it, then drops the database. */
export interface OpenFs extends AsyncDisposable {
  readonly fs: SqliteFs | PostgresFs | MssqlFs;
}

export interface FsCase {
  readonly name: string;
  open(): Promise<OpenFs>;
}

const sqlite = new Sqlite();
const postgres = new Postgres({ environment: process.env });
const sqlServer = new SqlServer({ environment: process.env });

export const fsCases: readonly FsCase[] = [
  {
    name: 'SqliteFs',
    async open() {
      const database = await sqlite.database();
      return {
        fs: new SqliteFs({ dbPath: database.path, root: '/' }),
        [Symbol.asyncDispose]: () => database.cleanup(),
      };
    },
  },
  {
    name: 'PostgresFs',
    async open() {
      await using stack = new AsyncDisposableStack();
      const database = stack.use(await postgres.database());
      const fs = await PostgresFs.create({
        pool: database.pool(),
        root: '/',
      });
      const owned = stack.move();
      return { fs, [Symbol.asyncDispose]: () => owned.disposeAsync() };
    },
  },
  {
    name: 'MssqlFs',
    async open() {
      await using stack = new AsyncDisposableStack();
      const database = stack.use(await sqlServer.database());
      const fs = await MssqlFs.create({
        pool: database.connectionString,
        root: '/',
      });
      stack.defer(() => fs.close());
      const owned = stack.move();
      return { fs, [Symbol.asyncDispose]: () => owned.disposeAsync() };
    },
  },
];
