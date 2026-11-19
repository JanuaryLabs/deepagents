import { Postgres } from '@zukhruf/testing/postgres';
import { Sqlite } from '@zukhruf/testing/sqlite';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  type ContextStore,
  PostgresContextStore,
  SqlServerContextStore,
  SqliteContextStore,
} from '@deepagents/context';

import { waitForFtsReady } from '../sqlserver/wait-for-fts-ready.ts';

/** A context store over a fresh database; disposal closes the store, then drops the database. */
export interface OpenStore extends AsyncDisposable {
  readonly store: ContextStore;
  /** Resolves once a search sees every message saved so far. */
  searchable(): Promise<void>;
}

export interface StoreCase {
  readonly name: string;
  /**
   * How the store matches a userId. SQL Server's default collation
   * (Latin1_General_CI_AS) ignores case; PostgreSQL and SQLite do not.
   */
  readonly userIdComparison: 'case-sensitive' | 'case-insensitive';
  /**
   * The order of `rank` in searchMessages results, most relevant first.
   * SQLite's FTS5 bm25 rank is lower for a better match; PostgreSQL's ts_rank
   * and SQL Server's CONTAINSTABLE RANK are higher.
   */
  readonly searchRankOrder: 'ascending' | 'descending';
  open(): Promise<OpenStore>;
}

const sqlite = new Sqlite();
const postgres = new Postgres({ environment: process.env });
const sqlServer = new SqlServer({ environment: process.env });

export const storeCases: readonly StoreCase[] = [
  {
    name: 'sqlite',
    userIdComparison: 'case-sensitive',
    searchRankOrder: 'ascending',
    async open() {
      const database = await sqlite.database();
      return {
        store: new SqliteContextStore(database.connection),
        searchable: async () => {},
        [Symbol.asyncDispose]: () => database.cleanup(),
      };
    },
  },
  {
    name: 'postgres',
    userIdComparison: 'case-sensitive',
    searchRankOrder: 'descending',
    async open() {
      await using stack = new AsyncDisposableStack();
      const database = stack.use(await postgres.database());
      const store = await PostgresContextStore.create({
        pool: database.connectionString,
      });
      stack.defer(() => store.close());
      const owned = stack.move();
      return {
        store,
        searchable: async () => {},
        [Symbol.asyncDispose]: () => owned.disposeAsync(),
      };
    },
  },
  {
    name: 'sqlserver',
    userIdComparison: 'case-insensitive',
    searchRankOrder: 'descending',
    async open() {
      await using stack = new AsyncDisposableStack();
      const database = stack.use(await sqlServer.database());
      const store = await SqlServerContextStore.create({
        pool: database.connectionString,
      });
      stack.defer(() => store.close());
      const owned = stack.move();
      return {
        store,
        searchable: () => waitForFtsReady(database.connectionString),
        [Symbol.asyncDispose]: () => owned.disposeAsync(),
      };
    },
  },
];
