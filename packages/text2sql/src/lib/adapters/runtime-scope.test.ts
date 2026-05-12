import { BigQuery as BigQueryClient } from '@google-cloud/bigquery';
import sql from 'mssql';
import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import pg from 'pg';

import {
  type MysqlContainer,
  startMysqlContainer,
  startPostgresContainer,
  startSqlServerContainer,
} from '@deepagents/test';
import type { GroundingFn, SQLScopeErrorPayload } from '@deepagents/text2sql';
import {
  BigQuery,
  tables as bigqueryTables,
  views as bigqueryViews,
} from '@deepagents/text2sql/bigquery';
import {
  Mysql,
  tables as mysqlTables,
  views as mysqlViews,
} from '@deepagents/text2sql/mysql';
import {
  Postgres,
  tables as postgresTables,
  views as postgresViews,
} from '@deepagents/text2sql/postgres';
import { Spreadsheet } from '@deepagents/text2sql/spreadsheet';
import {
  tables as sqliteTables,
  views as sqliteViews,
} from '@deepagents/text2sql/sqlite';
import {
  SqlServer,
  tables as sqlServerTables,
  views as sqlServerViews,
} from '@deepagents/text2sql/sqlserver';

import { init_db } from '../../tests/sqlite.ts';

function parseScopePayload(payload: string): SQLScopeErrorPayload {
  return JSON.parse(payload) as SQLScopeErrorPayload;
}

type RuntimeScopeProbe = {
  mock: {
    callCount(): number;
  };
};

type AdapterProbes = {
  execute: RuntimeScopeProbe;
  grounding: RuntimeScopeProbe;
  validate: RuntimeScopeProbe;
};

type AdapterFactoryResult = {
  adapter: {
    execute(sql: string): Promise<unknown>;
    validate(sql: string): Promise<string | void>;
  };
  probes: AdapterProbes;
};

type AdapterRuntime = {
  create: () => AdapterFactoryResult | Promise<AdapterFactoryResult>;
  createEmptyScope: () => AdapterFactoryResult | Promise<AdapterFactoryResult>;
  cleanup?: () => Promise<void>;
  queries: AdapterQueries;
};

type AdapterQueries = {
  executeResult: unknown[];
  inScopeSql: string;
  inScopeViewSql: string;
  outOfScopeSql: string;
  cteSql: string;
  subquerySql: string;
  setOperationSql: string;
};

type AdapterCase = {
  name: string;
  setup: () => Promise<AdapterRuntime | undefined>;
};

type RuntimeScopeOptions = {
  tables?: string[];
  views?: string[];
  grounding?: GroundingFn[];
};

function isSqliteGroundingQuery(sql: string): boolean {
  return (
    sql.startsWith('SELECT name FROM sqlite_master') ||
    sql.startsWith('PRAGMA table_info') ||
    sql.startsWith('PRAGMA foreign_key_list')
  );
}

const runtimeScopeSqliteDdl = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total REAL NOT NULL
  );
  CREATE TABLE secrets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER
  );
  CREATE TABLE passwords (
    id INTEGER PRIMARY KEY,
    secret_id INTEGER
  );
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE persist (id INTEGER PRIMARY KEY);
  CREATE TABLE integers (count INTEGER);
  CREATE TABLE "BoardGames" (
    id INTEGER PRIMARY KEY,
    "details.name" TEXT,
    "stats.average" REAL,
    "stats.usersrated" INTEGER
  );
  CREATE VIEW active_users AS SELECT id, name FROM users;

  INSERT INTO users (id, name) VALUES (1, 'Ada');
`;

async function createRuntimeSqlite(options: RuntimeScopeOptions = {}) {
  const executeProbe = mock.fn();
  const groundingProbe = mock.fn();
  const validateProbe = mock.fn();
  const grounding = options.grounding ?? [
    sqliteTables({ filter: options.tables ?? ['users'] }),
    sqliteViews({
      filter: options.views ?? ['active_users'],
      includeDefinition: false,
    }),
  ];
  // eslint-disable-next-line prefer-const
  let db: Awaited<ReturnType<typeof init_db>>['db'] | undefined;
  const initialized = await init_db(runtimeScopeSqliteDdl, {
    grounding,
    execute: async (sql) => {
      if (!db) throw new Error('SQLite test database was not initialized.');
      if (isSqliteGroundingQuery(sql)) {
        groundingProbe(sql);
      } else {
        executeProbe(sql);
      }
      return db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    },
    validate: async (sql) => {
      if (!db) throw new Error('SQLite test database was not initialized.');
      validateProbe(sql);
      db.prepare(`EXPLAIN ${sql}`).all();
      return undefined;
    },
  });
  db = initialized.db;

  return {
    probes: {
      execute: executeProbe,
      grounding: groundingProbe,
      validate: validateProbe,
    },
    adapter: initialized.adapter,
  };
}

const runtimeScopePostgresDdl = `
  DROP SCHEMA IF EXISTS private CASCADE;
  DROP VIEW IF EXISTS public.active_users;
  DROP TABLE IF EXISTS public.orders;
  DROP TABLE IF EXISTS public.users;

  CREATE SCHEMA private;
  CREATE TABLE public.users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE public.orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.users(id),
    total NUMERIC NOT NULL
  );
  CREATE TABLE private.secrets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER
  );
  CREATE VIEW public.active_users AS SELECT id, name FROM public.users;

  INSERT INTO public.users (id, name) VALUES (1, 'Ada');
`;

const runtimeScopeMysqlDdl = `
  DROP VIEW IF EXISTS active_users;
  DROP TABLE IF EXISTS orders;
  DROP TABLE IF EXISTS users;
  DROP DATABASE IF EXISTS admin;

  CREATE DATABASE admin;
  CREATE TABLE users (
    id INT PRIMARY KEY,
    name VARCHAR(255) NOT NULL
  );
  CREATE TABLE orders (
    id INT PRIMARY KEY,
    user_id INT NOT NULL,
    total DECIMAL(10, 2) NOT NULL,
    CONSTRAINT orders_users_fk FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE admin.secrets (
    id INT PRIMARY KEY,
    user_id INT
  );
  CREATE VIEW active_users AS SELECT id, name FROM users;

  INSERT INTO users (id, name) VALUES (1, 'Ada');
`;

const runtimeScopeSqlServerDdl = [
  `
    DROP VIEW IF EXISTS dbo.active_users;
    DROP TABLE IF EXISTS audit.secrets;
    DROP TABLE IF EXISTS dbo.orders;
    DROP TABLE IF EXISTS dbo.users;
    IF SCHEMA_ID(N'audit') IS NULL EXEC(N'CREATE SCHEMA audit');
  `,
  `
    CREATE TABLE dbo.users (
      id INT NOT NULL PRIMARY KEY,
      name NVARCHAR(255) NOT NULL
    );
  `,
  `
    CREATE TABLE dbo.orders (
      id INT NOT NULL PRIMARY KEY,
      user_id INT NOT NULL,
      total DECIMAL(10, 2) NOT NULL,
      CONSTRAINT orders_users_fk FOREIGN KEY (user_id) REFERENCES dbo.users(id)
    );
  `,
  `
    CREATE TABLE audit.secrets (
      id INT NOT NULL PRIMARY KEY,
      user_id INT NULL
    );
  `,
  'CREATE VIEW dbo.active_users AS SELECT id, name FROM dbo.users;',
  "INSERT INTO dbo.users (id, name) VALUES (1, N'Ada');",
];

const defaultRuntimeScopeQueries: AdapterQueries = {
  executeResult: [{ id: 1, name: 'Ada' }],
  inScopeSql: 'SELECT * FROM users',
  inScopeViewSql: 'SELECT * FROM active_users',
  outOfScopeSql: 'SELECT * FROM secrets',
  cteSql: 'WITH visible AS (SELECT * FROM users) SELECT * FROM visible',
  subquerySql: 'SELECT * FROM (SELECT * FROM users) AS visible',
  setOperationSql: 'SELECT * FROM users UNION SELECT * FROM users',
};

function isPostgresGroundingQuery(sqlText: string): boolean {
  return sqlText.includes('information_schema.');
}

function isMysqlGroundingQuery(sqlText: string): boolean {
  return (
    sqlText.includes('INFORMATION_SCHEMA.') ||
    sqlText.includes('INFORMATION_SCHEMA_') ||
    sqlText.includes('SELECT DATABASE()')
  );
}

function isSqlServerGroundingQuery(sqlText: string): boolean {
  return sqlText.includes('INFORMATION_SCHEMA.');
}

function isBigQueryGroundingQuery(sqlText: string): boolean {
  return sqlText.includes('INFORMATION_SCHEMA.');
}

function createPostgresScope(pool: pg.Pool, options: RuntimeScopeOptions = {}) {
  const executeProbe = mock.fn();
  const groundingProbe = mock.fn();
  const validateProbe = mock.fn();
  const grounding = options.grounding ?? [
    postgresTables({ filter: options.tables ?? ['public.users'] }),
    postgresViews({
      filter: options.views ?? ['public.active_users'],
      includeDefinition: false,
    }),
  ];

  return {
    adapter: new Postgres({
      grounding,
      execute: async (sql) => {
        if (isPostgresGroundingQuery(sql)) {
          groundingProbe(sql);
        } else {
          executeProbe(sql);
        }
        return (await pool.query(sql)).rows;
      },
      validate: async (sql) => {
        validateProbe(sql);
        await pool.query(`EXPLAIN ${sql}`);
        return undefined;
      },
    }),
    probes: {
      execute: executeProbe,
      grounding: groundingProbe,
      validate: validateProbe,
    },
  };
}

function createMysqlScope(
  container: MysqlContainer,
  options: RuntimeScopeOptions = {},
) {
  const executeProbe = mock.fn();
  const groundingProbe = mock.fn();
  const validateProbe = mock.fn();
  const grounding = options.grounding ?? [
    mysqlTables({ filter: options.tables ?? ['app.users'] }),
    mysqlViews({
      filter: options.views ?? ['app.active_users'],
      includeDefinition: false,
    }),
  ];

  return {
    adapter: new Mysql({
      databases: [container.database],
      grounding,
      execute: async (sql) => {
        if (isMysqlGroundingQuery(sql)) {
          groundingProbe(sql);
        } else {
          executeProbe(sql);
        }
        return container.query(sql);
      },
      validate: async (sql) => {
        validateProbe(sql);
        await container.query(`EXPLAIN ${sql}`);
        return undefined;
      },
    }),
    probes: {
      execute: executeProbe,
      grounding: groundingProbe,
      validate: validateProbe,
    },
  };
}

function createSqlServerScope(
  pool: sql.ConnectionPool,
  options: RuntimeScopeOptions = {},
) {
  const executeProbe = mock.fn();
  const groundingProbe = mock.fn();
  const validateProbe = mock.fn();
  const grounding = options.grounding ?? [
    sqlServerTables({ filter: options.tables ?? ['dbo.users'] }),
    sqlServerViews({
      filter: options.views ?? ['dbo.active_users'],
      includeDefinition: false,
    }),
  ];

  return {
    adapter: new SqlServer({
      grounding,
      execute: async (sql) => {
        if (isSqlServerGroundingQuery(sql)) {
          groundingProbe(sql);
        } else {
          executeProbe(sql);
        }
        return (await pool.request().query(sql)).recordset ?? [];
      },
      validate: async (sql) => {
        validateProbe(sql);
        await pool.request().query(sql);
        return undefined;
      },
    }),
    probes: {
      execute: executeProbe,
      grounding: groundingProbe,
      validate: validateProbe,
    },
  };
}

type BigQueryRuntime = {
  client: BigQueryClient;
  datasetId: string;
  location: string;
  projectId: string;
  cleanup: () => Promise<void>;
};

async function startBigQueryRuntime(): Promise<BigQueryRuntime | undefined> {
  const projectId =
    process.env['TEXT2SQL_BIGQUERY_PROJECT_ID'] ??
    process.env['GOOGLE_CLOUD_PROJECT'] ??
    'january-9f554';
  const location = process.env['TEXT2SQL_BIGQUERY_LOCATION'] ?? 'US';
  const datasetId = `text2sql_runtime_scope_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const client = new BigQueryClient({ projectId });
  const dataset = client.dataset(datasetId);

  try {
    await client.createDataset(datasetId, { location });
    await client.query({
      location,
      query: `
        CREATE TABLE \`${projectId}.${datasetId}.users\` (
          id INT64,
          name STRING
        );
        CREATE TABLE \`${projectId}.${datasetId}.secrets\` (
          id INT64,
          user_id INT64
        );
        INSERT INTO \`${projectId}.${datasetId}.users\` (id, name)
        VALUES (1, 'Ada');
        CREATE VIEW \`${projectId}.${datasetId}.active_users\` AS
        SELECT id, name FROM \`${projectId}.${datasetId}.users\`;
      `,
    });
  } catch (error) {
    try {
      await dataset.delete({ force: true });
    } catch {
      // Ignore cleanup failure for a dataset that may not have been created.
    }
    console.log(
      `Skipping BigQuery runtime scope tests: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  return {
    client,
    datasetId,
    location,
    projectId,
    cleanup: async () => {
      await dataset.delete({ force: true });
    },
  };
}

function createBigQueryScope(
  runtime: BigQueryRuntime,
  options: RuntimeScopeOptions = {},
) {
  const executeProbe = mock.fn();
  const groundingProbe = mock.fn();
  const validateProbe = mock.fn();
  const grounding = options.grounding ?? [
    bigqueryTables({
      filter: options.tables ?? [`${runtime.datasetId}.users`],
    }),
    bigqueryViews({
      filter: options.views ?? [`${runtime.datasetId}.active_users`],
      includeDefinition: false,
    }),
  ];
  const defaultDataset = {
    datasetId: runtime.datasetId,
    projectId: runtime.projectId,
  };

  return {
    adapter: new BigQuery({
      datasets: [runtime.datasetId],
      projectId: runtime.projectId,
      grounding,
      execute: async (sql) => {
        if (isBigQueryGroundingQuery(sql)) {
          groundingProbe(sql);
        } else {
          executeProbe(sql);
        }
        const [rows] = await runtime.client.query({
          defaultDataset,
          location: runtime.location,
          query: sql,
        });
        return rows;
      },
      validate: async (sql) => {
        validateProbe(sql);
        await runtime.client.createQueryJob({
          defaultDataset,
          dryRun: true,
          location: runtime.location,
          query: sql,
        });
        return undefined;
      },
    }),
    probes: {
      execute: executeProbe,
      grounding: groundingProbe,
      validate: validateProbe,
    },
  };
}

const adapterCases: AdapterCase[] = [
  {
    name: 'sqlite',
    setup: async () => ({
      create: () => createRuntimeSqlite(),
      createEmptyScope: () => createRuntimeSqlite({ grounding: [] }),
      queries: defaultRuntimeScopeQueries,
    }),
  },
  {
    name: 'postgres',
    setup: async () => {
      const container = await startPostgresContainer();
      if (!container) return undefined;
      const pool = new pg.Pool({
        connectionString: container.connectionString,
      });
      try {
        await pool.query(runtimeScopePostgresDdl);
      } catch (error) {
        await pool.end();
        await container.cleanup();
        throw error;
      }

      return {
        create: () => createPostgresScope(pool),
        createEmptyScope: () => createPostgresScope(pool, { grounding: [] }),
        cleanup: async () => {
          await pool.end();
          await container.cleanup();
        },
        queries: {
          ...defaultRuntimeScopeQueries,
          outOfScopeSql: 'SELECT * FROM private.secrets',
        },
      };
    },
  },
  {
    name: 'mysql',
    setup: async () => {
      const container = await startMysqlContainer();
      if (!container) return undefined;
      try {
        await container.query(runtimeScopeMysqlDdl);
      } catch (error) {
        await container.cleanup();
        throw error;
      }

      return {
        create: () => createMysqlScope(container),
        createEmptyScope: () => createMysqlScope(container, { grounding: [] }),
        cleanup: container.cleanup,
        queries: {
          ...defaultRuntimeScopeQueries,
          executeResult: [{ id: '1', name: 'Ada' }],
          outOfScopeSql: 'SELECT * FROM admin.secrets',
        },
      };
    },
  },
  {
    name: 'sqlserver',
    setup: async () => {
      const container = await startSqlServerContainer();
      if (!container) return undefined;
      const pool = new sql.ConnectionPool(container.connectionString);
      try {
        await pool.connect();
        for (const statement of runtimeScopeSqlServerDdl) {
          await pool.request().batch(statement);
        }
      } catch (error) {
        await pool.close();
        await container.cleanup();
        throw error;
      }

      return {
        create: () => createSqlServerScope(pool),
        createEmptyScope: () => createSqlServerScope(pool, { grounding: [] }),
        cleanup: async () => {
          await pool.close();
          await container.cleanup();
        },
        queries: {
          ...defaultRuntimeScopeQueries,
          inScopeSql: 'SELECT TOP 1 * FROM users',
          inScopeViewSql: 'SELECT TOP 1 * FROM active_users',
          outOfScopeSql: 'SELECT TOP 1 * FROM [audit].[secrets]',
          cteSql:
            'WITH visible AS (SELECT TOP 1 * FROM users) SELECT * FROM visible',
        },
      };
    },
  },
  {
    name: 'bigquery',
    setup: async () => {
      const runtime = await startBigQueryRuntime();
      if (!runtime) return undefined;

      return {
        create: () => createBigQueryScope(runtime),
        createEmptyScope: () => createBigQueryScope(runtime, { grounding: [] }),
        cleanup: runtime.cleanup,
        queries: {
          ...defaultRuntimeScopeQueries,
          setOperationSql: 'SELECT * FROM users UNION ALL SELECT * FROM users',
        },
      };
    },
  },
];

for (const adapterCase of adapterCases) {
  describe(`${adapterCase.name} runtime scope`, () => {
    let runtime: AdapterRuntime | undefined;

    before(async () => {
      runtime = await adapterCase.setup();
    });

    after(async () => {
      await runtime?.cleanup?.();
      runtime = undefined;
    });

    async function createAdapter() {
      return runtime?.create();
    }

    async function createEmptyScopeAdapter() {
      return runtime?.createEmptyScope();
    }

    it('allows entity-free queries', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate('SELECT 1');

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('allows in-scope table queries in validate', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.inScopeSql);

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('allows in-scope table queries in execute', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.execute(runtime.queries.inScopeSql);

      assert.deepStrictEqual(result, runtime.queries.executeResult);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 1);
    });

    it('allows in-scope view queries in validate', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.inScopeViewSql);

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('allows in-scope view queries in execute', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.execute(runtime.queries.inScopeViewSql);

      assert.deepStrictEqual(result, runtime.queries.executeResult);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 1);
    });

    it('allows CTE queries when their base entities are grounded', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.cteSql);

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('allows subquery queries when their base entities are grounded', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.subquerySql);

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('allows set-operation queries when their base entities are grounded', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.setOperationSql);

      assert.strictEqual(result, undefined);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 1);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('blocks out-of-scope validate queries before hitting the db validator', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.outOfScopeSql);

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('blocks out-of-scope execute queries before hitting the db executor', async () => {
      const created = await createAdapter();
      if (!created || !runtime) return;
      const rt = runtime;
      const { adapter, probes } = created;

      await assert.rejects(
        () => adapter.execute(rt.queries.outOfScopeSql),
        (error: unknown) => {
          const payload = parseScopePayload(
            error instanceof Error ? error.message : String(error),
          );
          assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
          return true;
        },
      );

      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('blocks base-entity validate queries when grounded scope resolves no entities', async () => {
      const created = await createEmptyScopeAdapter();
      if (!created || !runtime) return;
      const { adapter, probes } = created;

      const result = await adapter.validate(runtime.queries.inScopeSql);

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('blocks base-entity execute queries when grounded scope resolves no entities', async () => {
      const created = await createEmptyScopeAdapter();
      if (!created || !runtime) return;
      const rt = runtime;
      const { adapter, probes } = created;

      await assert.rejects(
        () => adapter.execute(rt.queries.inScopeSql),
        (error: unknown) => {
          const payload = parseScopePayload(
            error instanceof Error ? error.message : String(error),
          );
          assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
          return true;
        },
      );

      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });

    it('returns SQL_SCOPE_PARSE_ERROR and never touches the db on parse failure', async () => {
      const created = await createAdapter();
      if (!created) return;
      const { adapter, probes } = created;

      const result = await adapter.validate('SELECT * FROM');

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
      assert.ok(probes.grounding.mock.callCount() > 0);
      assert.strictEqual(probes.validate.mock.callCount(), 0);
      assert.strictEqual(probes.execute.mock.callCount(), 0);
    });
  });
}

describe('sqlite runtime scope traversal', () => {
  it('uses the closest supported parser dialect for sqlite reserved identifiers', async () => {
    const { adapter, probes } = await createRuntimeSqlite({
      tables: ['persist', 'integers'],
      views: [],
    });

    assert.strictEqual(
      await adapter.validate('SELECT * FROM persist'),
      undefined,
    );
    assert.strictEqual(
      await adapter.validate('SELECT SUM(count) AS total FROM integers'),
      undefined,
    );
    assert.ok(probes.grounding.mock.callCount() > 0);
    assert.strictEqual(probes.validate.mock.callCount(), 2);
  });

  it('parses sqlite-only syntax (json_each, dotted quoted identifiers)', async () => {
    const { adapter, probes } = await createRuntimeSqlite({
      tables: ['BoardGames'],
      views: [],
    });

    const sql = `WITH base AS (
        SELECT "details.name" AS game_name, "stats.average" AS rating
        FROM BoardGames
        WHERE "stats.usersrated" >= 10
      ),
      tokens AS (
        SELECT game_name, TRIM(value) AS mechanic
        FROM base, json_each('["a","b"]')
      )
      SELECT mechanic, COUNT(*) FROM tokens GROUP BY mechanic`;

    assert.strictEqual(await adapter.validate(sql), undefined);
    assert.ok(probes.grounding.mock.callCount() > 0);
    assert.strictEqual(probes.validate.mock.callCount(), 1);
  });

  it('allows traversal-expanded grounded tables', async () => {
    const { adapter, probes } = await createRuntimeSqlite({
      grounding: [sqliteTables({ filter: ['posts'], forward: true })],
    });

    const result = await adapter.validate('SELECT * FROM users');

    assert.strictEqual(result, undefined);
    assert.ok(
      probes.grounding.mock.callCount() > 0,
      'grounding should resolve related tables',
    );
    assert.strictEqual(probes.validate.mock.callCount(), 1);
    assert.strictEqual(probes.execute.mock.callCount(), 0);
  });
});

describe('spreadsheet runtime scope', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('enforces runtime scope through the inherited sqlite adapter', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'text2sql-scope-'));
    tempDirs.push(dir);

    const file = path.join(dir, 'users.csv');
    await fs.writeFile(file, 'id,name\n1,Ada\n');

    const adapter = new Spreadsheet({
      file,
      grounding: [sqliteTables({ filter: ['users'] })],
    });

    assert.strictEqual(
      await adapter.validate('SELECT * FROM users'),
      undefined,
    );

    const blocked = await adapter.validate('SELECT * FROM secrets');
    assert.ok(typeof blocked === 'string');
    assert.strictEqual(parseScopePayload(blocked).error_type, 'OUT_OF_SCOPE');

    const parseFailure = await adapter.validate('SELECT * FROM');
    assert.ok(typeof parseFailure === 'string');
    assert.strictEqual(
      parseScopePayload(parseFailure).error_type,
      'SQL_SCOPE_PARSE_ERROR',
    );

    const rows = await adapter.execute('SELECT * FROM users');
    assert.deepStrictEqual(
      rows.map((row: Record<string, unknown>) => ({ ...row })),
      [{ id: 1, name: 'Ada' }],
    );
  });
});

describe('scope enforcement edge cases', () => {
  async function createSqlite(tables: string[], views: string[] = []) {
    return createRuntimeSqlite({ tables, views });
  }

  it('allows multiple allowed tables via JOIN', async () => {
    const { adapter, probes } = await createSqlite(['users', 'orders']);
    const result = await adapter.validate(
      'SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id',
    );
    assert.strictEqual(result, undefined);
    assert.ok(probes.grounding.mock.callCount() > 0);
    assert.strictEqual(probes.validate.mock.callCount(), 1);
  });

  it('blocks when one of multiple JOINed tables is unauthorized', async () => {
    const { adapter } = await createSqlite(['users']);
    const result = await adapter.validate(
      'SELECT * FROM users JOIN secrets ON users.id = secrets.user_id',
    );
    assert.ok(typeof result === 'string');
    const payload = parseScopePayload(result);
    assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
    assert.ok(payload.referenced_entities?.includes('secrets'));
  });

  it('matches table names case-insensitively', async () => {
    const { adapter } = await createSqlite(['users']);
    const result = await adapter.validate('SELECT * FROM USERS');
    assert.strictEqual(result, undefined);
  });

  it('blocks subquery referencing unauthorized table', async () => {
    const { adapter } = await createSqlite(['users']);
    const result = await adapter.validate(
      'SELECT * FROM users WHERE id IN (SELECT user_id FROM secrets)',
    );
    assert.ok(typeof result === 'string');
    const payload = parseScopePayload(result);
    assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
    assert.ok(payload.referenced_entities?.includes('secrets'));
  });

  it('lists all unauthorized tables in error payload', async () => {
    const { adapter } = await createSqlite(['users']);
    const result = await adapter.validate(
      'SELECT * FROM secrets JOIN passwords ON secrets.id = passwords.secret_id',
    );
    assert.ok(typeof result === 'string');
    const payload = parseScopePayload(result);
    assert.ok(payload.referenced_entities?.includes('secrets'));
    assert.ok(payload.referenced_entities?.includes('passwords'));
  });

  it('blocks UNION query when one table is unauthorized', async () => {
    const { adapter } = await createSqlite(['users']);
    const result = await adapter.validate(
      'SELECT name FROM users UNION SELECT name FROM secrets',
    );
    assert.ok(typeof result === 'string');
    const payload = parseScopePayload(result);
    assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
    assert.ok(payload.referenced_entities?.includes('secrets'));
  });

  it('normalizes mixed-case entries in grounding', async () => {
    const { adapter } = await createSqlite(['Users', 'ORDERS']);
    const result = await adapter.validate(
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id',
    );
    assert.strictEqual(result, undefined);
  });

  it('passes through entity-free query even with empty allowed set', async () => {
    const { adapter } = await createSqlite([]);
    const result = await adapter.validate('SELECT 1 + 1');
    assert.strictEqual(result, undefined);
  });
});

describe('bigquery scope normalization', () => {
  let runtime: BigQueryRuntime | undefined;

  before(async () => {
    runtime = await startBigQueryRuntime();
  });

  after(async () => {
    await runtime?.cleanup();
    runtime = undefined;
  });

  function createBigQuery(tables: string[], views: string[] = []) {
    assert.ok(runtime, 'BigQuery runtime must be available');
    return createBigQueryScope(runtime, {
      tables,
      views,
      grounding: [
        bigqueryTables({ filter: tables }),
        bigqueryViews({ filter: views, includeDefinition: false }),
      ],
    });
  }

  it('allows backtick-quoted 3-part name when dataset.table is in allowed set', async () => {
    if (!runtime) return;
    const { adapter } = createBigQuery([`${runtime.datasetId}.users`]);
    const result = await adapter.validate(
      `SELECT id, name FROM \`${runtime.projectId}.${runtime.datasetId}.users\` LIMIT 50`,
    );
    assert.strictEqual(result, undefined);
  });

  it('blocks unauthorized backtick-quoted 3-part name', async () => {
    if (!runtime) return;
    const { adapter } = createBigQuery([`${runtime.datasetId}.users`]);
    const result = await adapter.validate(
      `SELECT * FROM \`${runtime.projectId}.${runtime.datasetId}.secrets\``,
    );
    assert.ok(typeof result === 'string');
    const payload = parseScopePayload(result);
    assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
  });

  it('allows unquoted 2-part dataset.table name', async () => {
    if (!runtime) return;
    const { adapter } = createBigQuery([`${runtime.datasetId}.users`]);
    const result = await adapter.validate(
      `SELECT * FROM ${runtime.datasetId}.users`,
    );
    assert.strictEqual(result, undefined);
  });
});
