import assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { GroundingFn, SQLScopeErrorPayload } from '@deepagents/text2sql';
import { BigQuery } from '@deepagents/text2sql/bigquery';
import {
  AbstractGrounding,
  type GroundingContext,
} from '@deepagents/text2sql/grounding';
import { Mysql } from '@deepagents/text2sql/mysql';
import { Postgres } from '@deepagents/text2sql/postgres';
import { Spreadsheet } from '@deepagents/text2sql/spreadsheet';
import { Sqlite, tables as sqliteTables } from '@deepagents/text2sql/sqlite';
import { SqlServer } from '@deepagents/text2sql/sqlserver';

class StaticScopeGrounding extends AbstractGrounding {
  readonly #tables: string[];
  readonly #views: string[];

  constructor(tables: string[], views: string[] = []) {
    super('static-scope');
    this.#tables = tables;
    this.#views = views;
  }

  override async execute(ctx: GroundingContext): Promise<void> {
    ctx.tables.push(
      ...this.#tables.map((name) => ({
        name,
        columns: [],
      })),
    );
    ctx.views.push(
      ...this.#views.map((name) => ({
        name,
        columns: [],
      })),
    );
  }
}

function staticScopeGrounding(
  tables: string[],
  views: string[] = [],
): GroundingFn {
  return () => new StaticScopeGrounding(tables, views);
}

function parseScopePayload(payload: string): SQLScopeErrorPayload {
  return JSON.parse(payload) as SQLScopeErrorPayload;
}

type AdapterCalls = {
  execute: number;
  validate: number;
};

type AdapterFactory = () => {
  adapter: {
    execute(sql: string): Promise<unknown>;
    validate(sql: string): Promise<string | void>;
  };
  calls: AdapterCalls;
};

type AdapterCase = {
  name: string;
  create: AdapterFactory;
  createEmptyScope: AdapterFactory;
  inScopeSql: string;
  inScopeViewSql: string;
  outOfScopeSql: string;
  cteSql: string;
  subquerySql: string;
  setOperationSql: string;
};

const adapterCases: AdapterCase[] = [
  {
    name: 'sqlite',
    create: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Sqlite({
          grounding: [staticScopeGrounding(['users'], ['active_users'])],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    createEmptyScope: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Sqlite({
          grounding: [],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    inScopeSql: 'SELECT * FROM users',
    inScopeViewSql: 'SELECT * FROM active_users',
    outOfScopeSql: 'SELECT * FROM secrets',
    cteSql: 'WITH visible AS (SELECT * FROM users) SELECT * FROM visible',
    subquerySql: 'SELECT * FROM (SELECT * FROM users) AS visible',
    setOperationSql: 'SELECT * FROM users UNION SELECT * FROM users',
  },
  {
    name: 'postgres',
    create: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Postgres({
          grounding: [
            staticScopeGrounding(['public.users'], ['public.active_users']),
          ],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    createEmptyScope: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Postgres({
          grounding: [],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    inScopeSql: 'SELECT * FROM users',
    inScopeViewSql: 'SELECT * FROM active_users',
    outOfScopeSql: 'SELECT * FROM private.secrets',
    cteSql: 'WITH visible AS (SELECT * FROM users) SELECT * FROM visible',
    subquerySql: 'SELECT * FROM (SELECT * FROM users) AS visible',
    setOperationSql: 'SELECT * FROM users UNION SELECT * FROM users',
  },
  {
    name: 'mysql',
    create: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Mysql({
          grounding: [
            staticScopeGrounding(['app.users'], ['app.active_users']),
          ],
          databases: ['app'],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    createEmptyScope: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new Mysql({
          grounding: [],
          databases: ['app'],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    inScopeSql: 'SELECT * FROM users',
    inScopeViewSql: 'SELECT * FROM active_users',
    outOfScopeSql: 'SELECT * FROM admin.secrets',
    cteSql: 'WITH visible AS (SELECT * FROM users) SELECT * FROM visible',
    subquerySql: 'SELECT * FROM (SELECT * FROM users) AS visible',
    setOperationSql: 'SELECT * FROM users UNION SELECT * FROM users',
  },
  {
    name: 'sqlserver',
    create: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new SqlServer({
          grounding: [
            staticScopeGrounding(['dbo.users'], ['dbo.active_users']),
          ],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    createEmptyScope: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new SqlServer({
          grounding: [],
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    inScopeSql: 'SELECT TOP 1 * FROM users',
    inScopeViewSql: 'SELECT TOP 1 * FROM active_users',
    outOfScopeSql: 'SELECT TOP 1 * FROM [audit].[secrets]',
    cteSql: 'WITH visible AS (SELECT TOP 1 * FROM users) SELECT * FROM visible',
    subquerySql: 'SELECT * FROM (SELECT * FROM users) AS visible',
    setOperationSql: 'SELECT * FROM users UNION SELECT * FROM users',
  },
  {
    name: 'bigquery',
    create: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new BigQuery({
          grounding: [
            staticScopeGrounding(
              ['analytics.users'],
              ['analytics.active_users'],
            ),
          ],
          datasets: ['analytics'],
          projectId: 'proj',
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    createEmptyScope: () => {
      const calls = { execute: 0, validate: 0 };
      return {
        calls,
        adapter: new BigQuery({
          grounding: [],
          datasets: ['analytics'],
          projectId: 'proj',
          execute: async () => {
            calls.execute += 1;
            return [{ ok: true }];
          },
          validate: async () => {
            calls.validate += 1;
            return undefined;
          },
        }),
      };
    },
    inScopeSql: 'SELECT * FROM `proj.analytics.users`',
    inScopeViewSql: 'SELECT * FROM `proj.analytics.active_users`',
    outOfScopeSql: 'SELECT * FROM `proj.analytics.secrets`',
    cteSql:
      'WITH visible AS (SELECT * FROM `proj.analytics.users`) SELECT * FROM visible',
    subquerySql:
      'SELECT * FROM (SELECT * FROM `proj.analytics.users`) AS visible',
    setOperationSql:
      'SELECT * FROM `proj.analytics.users` UNION SELECT * FROM `proj.analytics.users`',
  },
];

for (const adapterCase of adapterCases) {
  describe(`${adapterCase.name} runtime scope`, () => {
    it('allows entity-free queries', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate('SELECT 1');

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('allows in-scope table queries in validate', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.inScopeSql);

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('allows in-scope table queries in execute', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.execute(adapterCase.inScopeSql);

      assert.deepStrictEqual(result, [{ ok: true }]);
      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 1);
    });

    it('allows in-scope view queries in validate', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.inScopeViewSql);

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('allows in-scope view queries in execute', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.execute(adapterCase.inScopeViewSql);

      assert.deepStrictEqual(result, [{ ok: true }]);
      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 1);
    });

    it('allows CTE queries when their base entities are grounded', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.cteSql);

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('allows subquery queries when their base entities are grounded', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.subquerySql);

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('allows set-operation queries when their base entities are grounded', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.setOperationSql);

      assert.strictEqual(result, undefined);
      assert.strictEqual(calls.validate, 1);
      assert.strictEqual(calls.execute, 0);
    });

    it('blocks out-of-scope validate queries before hitting the db validator', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate(adapterCase.outOfScopeSql);

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 0);
    });

    it('blocks out-of-scope execute queries before hitting the db executor', async () => {
      const { adapter, calls } = adapterCase.create();

      await assert.rejects(
        () => adapter.execute(adapterCase.outOfScopeSql),
        (error: unknown) => {
          const payload = parseScopePayload(
            error instanceof Error ? error.message : String(error),
          );
          assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
          return true;
        },
      );

      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 0);
    });

    it('blocks base-entity validate queries when grounded scope resolves no entities', async () => {
      const { adapter, calls } = adapterCase.createEmptyScope();

      const result = await adapter.validate(adapterCase.inScopeSql);

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 0);
    });

    it('blocks base-entity execute queries when grounded scope resolves no entities', async () => {
      const { adapter, calls } = adapterCase.createEmptyScope();

      await assert.rejects(
        () => adapter.execute(adapterCase.inScopeSql),
        (error: unknown) => {
          const payload = parseScopePayload(
            error instanceof Error ? error.message : String(error),
          );
          assert.strictEqual(payload.error_type, 'OUT_OF_SCOPE');
          return true;
        },
      );

      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 0);
    });

    it('returns SQL_SCOPE_PARSE_ERROR and never touches the db on parse failure', async () => {
      const { adapter, calls } = adapterCase.create();

      const result = await adapter.validate('SELECT * FROM');

      assert.ok(typeof result === 'string');
      const payload = parseScopePayload(result);
      assert.strictEqual(payload.error_type, 'SQL_SCOPE_PARSE_ERROR');
      assert.strictEqual(calls.validate, 0);
      assert.strictEqual(calls.execute, 0);
    });
  });
}

describe('sqlite runtime scope traversal', () => {
  it('uses the closest supported parser dialect for sqlite reserved identifiers', async () => {
    const calls = { validate: 0 };
    const adapter = new Sqlite({
      grounding: [staticScopeGrounding(['persist', 'integers'])],
      execute: async () => [{ ok: true }],
      validate: async () => {
        calls.validate += 1;
        return undefined;
      },
    });

    assert.strictEqual(
      await adapter.validate('SELECT * FROM persist'),
      undefined,
    );
    assert.strictEqual(
      await adapter.validate('SELECT SUM(count) AS total FROM integers'),
      undefined,
    );
    assert.strictEqual(calls.validate, 2);
  });

  it('allows traversal-expanded grounded tables', async () => {
    const calls = { execute: 0 };
    const adapter = new Sqlite({
      grounding: [sqliteTables({ filter: ['posts'], forward: true })],
      execute: async (sql) => {
        calls.execute += 1;
        if (sql.startsWith('PRAGMA table_info')) {
          if (sql.includes('"posts"')) {
            return [
              { name: 'id', type: 'INTEGER', pk: 1 },
              { name: 'user_id', type: 'INTEGER', pk: 0 },
            ];
          }
          return [
            { name: 'id', type: 'INTEGER', pk: 1 },
            { name: 'name', type: 'TEXT', pk: 0 },
          ];
        }
        if (sql.startsWith('PRAGMA foreign_key_list')) {
          if (sql.includes("'posts'")) {
            return [{ id: 0, table: 'users', from: 'user_id', to: 'id' }];
          }
          return [];
        }
        if (sql.startsWith('SELECT name FROM sqlite_master')) {
          return [{ name: 'posts' }, { name: 'users' }];
        }
        return [{ ok: true }];
      },
      validate: async () => undefined,
    });

    const result = await adapter.validate('SELECT * FROM users');

    assert.strictEqual(result, undefined);
    assert.ok(calls.execute > 0, 'grounding should resolve related tables');
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
