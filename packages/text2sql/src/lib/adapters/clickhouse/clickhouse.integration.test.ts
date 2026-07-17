import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  type Container,
  isDockerAvailable,
  startContainer,
  timebox,
} from '@deepagents/test';
import {
  ClickHouse,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/clickhouse';

const CLICKHOUSE_IMAGES = process.env.CLICKHOUSE_TEST_IMAGE
  ? [process.env.CLICKHOUSE_TEST_IMAGE]
  : [
      'clickhouse/clickhouse-server:25.8.28.1',
      'clickhouse/clickhouse-server:26.6.1.1193',
    ];
const DATABASE = 'analytics';
const USER = 'deepagents_test';
const PASSWORD = 'deepagents_test';
const NOT_READONLY_USER = 'deepagents_not_readonly';
const NOT_READONLY_PASSWORD = 'deepagents_not_readonly';

type ClickHouseJsonResult<Row> = {
  data: Row[];
  exception?: string;
};

const dockerAvailable = await isDockerAvailable();

for (const CLICKHOUSE_IMAGE of CLICKHOUSE_IMAGES) {
  describe(
    `ClickHouse adapter (${CLICKHOUSE_IMAGE})`,
    { skip: !dockerAvailable },
    () => {
      let container: Container;
      let query: (sql: string) => Promise<ClickHouseJsonResult<unknown>>;
      const databaseQueries: string[] = [];

      before(async () => {
        container = await startContainer({
          image: CLICKHOUSE_IMAGE,
          internalPort: 8123,
          env: { CLICKHOUSE_SKIP_USER_SETUP: '1' },
          healthy: ({ exec }) =>
            timebox(() => exec(['clickhouse-client', '--query', 'SELECT 1']), {
              maxRetryTime: 60_000,
            }),
        });

        await container.exec([
          'clickhouse-client',
          '--multiquery',
          '--query',
          `
        CREATE DATABASE ${DATABASE};
        CREATE DATABASE archive;
        CREATE TABLE ${DATABASE}.users
        (
          id UInt64,
          name String,
          team_id UInt64,
          created_at DateTime DEFAULT now(),
          nickname Nullable(String),
          INDEX name_bloom name TYPE bloom_filter(0.01) GRANULARITY 1
        )
        ENGINE = MergeTree
        ORDER BY id;
        CREATE VIEW ${DATABASE}.active_users AS
        SELECT id, name, team_id FROM ${DATABASE}.users;
        CREATE TABLE ${DATABASE}.teams
        (
          id UInt64,
          name String
        )
        ENGINE = MergeTree
        ORDER BY id;
        CREATE TABLE ${DATABASE}.secrets
        (
          id UInt64,
          value String
        )
        ENGINE = MergeTree
        ORDER BY id;
        CREATE TABLE ${DATABASE}.Users
        (
          id UInt64,
          secret String
        )
        ENGINE = MergeTree
        ORDER BY id;
        CREATE TABLE archive.secrets
        (
          id UInt64,
          value String
        )
        ENGINE = MergeTree
        ORDER BY id;
        INSERT INTO ${DATABASE}.users (id, name, team_id)
        VALUES (1, 'Ada', 10), (2, 'Grace', 20);
        INSERT INTO ${DATABASE}.teams VALUES (10, 'Research'), (20, 'Platform');
        CREATE FUNCTION deepagents_plus_one AS (value) -> value + 1;
        CREATE ROLE deepagents_readonly;
        GRANT SELECT ON ${DATABASE}.* TO deepagents_readonly;
        GRANT SELECT ON archive.secrets TO deepagents_readonly;
        GRANT SELECT ON system.data_skipping_indices TO deepagents_readonly;
        GRANT SELECT ON system.functions TO deepagents_readonly;
        ALTER ROLE deepagents_readonly SETTINGS readonly = 1;
        CREATE USER ${USER}
        IDENTIFIED WITH sha256_password BY '${PASSWORD}';
        GRANT deepagents_readonly TO ${USER};
        ALTER USER ${USER} DEFAULT ROLE deepagents_readonly;
        CREATE USER ${NOT_READONLY_USER}
        IDENTIFIED WITH sha256_password BY '${NOT_READONLY_PASSWORD}';
        GRANT SELECT ON ${DATABASE}.* TO ${NOT_READONLY_USER};
      `,
        ]);

        const endpoint = new URL(`http://${container.host}:${container.port}/`);
        endpoint.searchParams.set('user', USER);
        endpoint.searchParams.set('password', PASSWORD);
        endpoint.searchParams.set('database', DATABASE);
        endpoint.searchParams.set('default_format', 'JSON');

        query = async (sql) => {
          databaseQueries.push(sql);
          const response = await fetch(endpoint, { method: 'POST', body: sql });
          if (!response.ok) {
            throw new Error(await response.text());
          }
          const result =
            (await response.json()) as ClickHouseJsonResult<unknown>;
          if (result.exception) throw new Error(result.exception);
          return result;
        };
      });

      after(async () => {
        await container?.cleanup();
      });

      beforeEach(() => {
        databaseQueries.length = 0;
      });

      it('executes a grounded SELECT through the public adapter', async () => {
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => undefined,
        });

        const result = await adapter.execute(
          'SELECT id, name FROM users ORDER BY id',
        );

        assert.deepEqual(result, [
          { id: 1, name: 'Ada' },
          { id: 2, name: 'Grace' },
        ]);
      });

      it('introspects ClickHouse metadata through the public grounding surface', async () => {
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [
            info(),
            tables({ filter: [`${DATABASE}.users`] }),
            views({ filter: [`${DATABASE}.active_users`] }),
            rowCount(),
            constraints(),
            indexes(),
          ],
          validate: async () => undefined,
        });

        const fragments = await adapter.introspect();
        const dialect = fragments.find(
          (fragment) => fragment.name === 'dialectInfo',
        );
        const users = fragments.find(
          (fragment) =>
            fragment.name === 'table' &&
            (fragment.data as any)?.name === `${DATABASE}.users`,
        );
        const activeUsers = fragments.find(
          (fragment) =>
            fragment.name === 'view' &&
            (fragment.data as any)?.name === `${DATABASE}.active_users`,
        );
        const dialectData = dialect?.data as any;
        const usersData = users?.data as any;
        const activeUsersData = activeUsers?.data as any;

        assert.equal(dialectData?.dialect, 'clickhouse');
        assert.match(String(dialectData?.version), /^\d+\.\d+\./);
        assert.equal(dialectData?.database, DATABASE);
        assert.equal(usersData?.rowCount, 2);
        assert.equal(usersData?.sizeHint, 'tiny');

        const columns = usersData?.columns as
          Array<{ name: string; data: Record<string, unknown> }> | undefined;
        assert.deepEqual(
          columns?.find((column) => column.data.name === 'id')?.data,
          {
            name: 'id',
            type: 'UInt64',
            pk: true,
            notNull: true,
            indexed: true,
          },
        );
        assert.deepEqual(
          columns?.find((column) => column.data.name === 'created_at')?.data,
          {
            name: 'created_at',
            type: 'DateTime',
            notNull: true,
            default: 'now()',
          },
        );
        assert.deepEqual(
          columns?.find((column) => column.data.name === 'nickname')?.data,
          { name: 'nickname', type: 'Nullable(String)' },
        );

        const tableIndexes = usersData?.indexes as
          Array<{ name: string; data: Record<string, unknown> }> | undefined;
        assert.deepEqual(
          tableIndexes?.map((index) => index.data),
          [
            { name: 'PRIMARY_KEY', columns: ['id'], type: 'PRIMARY_KEY' },
            {
              name: 'name_bloom',
              columns: ['name'],
              type: 'bloom_filter(0.01)',
            },
          ],
        );
        assert.match(String(activeUsersData?.definition), /^CREATE VIEW/);
      });

      it('rejects an out-of-scope relation in an unused CTE before validation', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = `
      WITH
        visible AS (SELECT * FROM users),
        hidden AS (SELECT * FROM secrets)
      SELECT * FROM visible
    `;

        const result = await adapter.validate(sql);
        await assert.rejects(
          () => adapter.execute(sql),
          (error: unknown) =>
            error instanceof Error && error.name === 'SQLScopeError',
        );

        assert.equal(validatorCalls, 0);
        assert.ok(typeof result === 'string');
        assert.equal(JSON.parse(result).error_type, 'OUT_OF_SCOPE');
        assert.match(result, /secrets/);
        assert.ok(!databaseQueries.includes(sql));
        assert.equal(
          databaseQueries.filter((queryText) =>
            queryText.startsWith('EXPLAIN AST'),
          ).length,
          2,
        );
      });

      it('rejects mutation SQL before it reaches the consumer executor', async () => {
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => undefined,
        });
        const sql = "INSERT INTO users VALUES (3, 'Linus', 30)";

        await assert.rejects(
          () => adapter.execute(sql),
          (error: unknown) =>
            error instanceof Error && error.name === 'SQLReadOnlyError',
        );
        assert.ok(!databaseQueries.includes(sql));
      });

      it('rejects a connection whose effective readonly setting is not 1', async () => {
        const queries: string[] = [];
        const endpoint = new URL(`http://${container.host}:${container.port}/`);
        endpoint.searchParams.set('user', NOT_READONLY_USER);
        endpoint.searchParams.set('password', NOT_READONLY_PASSWORD);
        endpoint.searchParams.set('database', DATABASE);
        endpoint.searchParams.set('default_format', 'JSON');
        const notReadonlyQuery = async (sql: string) => {
          queries.push(sql);
          const response = await fetch(endpoint, { method: 'POST', body: sql });
          if (!response.ok) throw new Error(await response.text());
          const result =
            (await response.json()) as ClickHouseJsonResult<unknown>;
          if (result.exception) throw new Error(result.exception);
          return result;
        };
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: notReadonlyQuery,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = 'SELECT * FROM users';

        const validation = await adapter.validate(sql);
        await assert.rejects(
          () => adapter.execute(sql),
          (error: unknown) =>
            error instanceof Error && error.name === 'SQLScopeError',
        );

        assert.ok(typeof validation === 'string');
        assert.equal(
          JSON.parse(validation).error_type,
          'SQL_SCOPE_PARSE_ERROR',
        );
        assert.match(validation, /readonly = 1/);
        assert.equal(validatorCalls, 0);
        assert.ok(!queries.includes(sql));
        assert.deepEqual(queries, [
          "SELECT getSetting('readonly') AS readonly, currentDatabase() AS database",
        ]);
      });

      it('rejects table functions before they reach the consumer validator', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [],
          validate: async () => {
            validatorCalls++;
          },
        });
        const statements = [
          'SELECT * FROM numbers(10)',
          "SELECT * FROM file('fixture.csv', CSV, 'value String')",
          "SELECT * FROM url('https://example.com/data.csv', CSV, 'value String')",
          "SELECT * FROM s3('https://example.com/bucket/file.csv', CSV, 'value String')",
          "SELECT * FROM remote('127.0.0.1', 'analytics.users')",
        ];

        for (const sql of statements) {
          assert.equal(
            await adapter.validate(sql),
            'only SELECT queries allowed',
          );
          assert.ok(!databaseQueries.includes(sql));
        }

        assert.equal(validatorCalls, 0);
        assert.ok(
          !databaseQueries.some((queryText) =>
            queryText.startsWith('EXPLAIN QUERY TREE'),
          ),
        );
      });

      it('rejects outfile, mutations, multiple statements, and malformed SQL', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const statements = [
          "SELECT * FROM users INTO OUTFILE '/tmp/users.tsv'",
          'ALTER TABLE users DELETE WHERE id = 1',
          'SELECT * FROM users; SELECT * FROM users',
          'SELECT FROM users',
        ];

        for (const sql of statements) {
          const result = await adapter.validate(sql);
          assert.ok(typeof result === 'string');
          assert.ok(
            result === 'only SELECT queries allowed' ||
              JSON.parse(result).error_type === 'SQL_SCOPE_PARSE_ERROR',
          );
          assert.ok(!databaseQueries.includes(sql));
        }
        assert.equal(validatorCalls, 0);
      });

      it('fails closed on unapproved real AST and query-tree nodes', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const cases = [
          {
            sql: 'SELECT * EXCEPT team_id FROM users',
            unknownNode: 'ColumnsTransformerList',
          },
          {
            sql: 'SELECT id FROM users ORDER BY id WITH FILL FROM 0 TO 10 STEP 1',
            unknownNode: 'FILL FROM',
          },
        ];

        for (const fixture of cases) {
          const result = await adapter.validate(fixture.sql);
          assert.ok(typeof result === 'string');
          assert.equal(JSON.parse(result).error_type, 'SQL_SCOPE_PARSE_ERROR');
          assert.match(result, new RegExp(fixture.unknownNode));
          assert.ok(!databaseQueries.includes(fixture.sql));
        }
        assert.equal(validatorCalls, 0);
      });

      it('rejects non-system functions before they reach the consumer validator', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = 'SELECT deepagents_plus_one(id) FROM users';

        const result = await adapter.validate(sql);

        assert.equal(result, 'only SELECT queries allowed');
        assert.equal(validatorCalls, 0);
        assert.ok(!databaseQueries.includes(sql));
        assert.ok(
          databaseQueries.some((queryText) =>
            queryText.includes('system.functions'),
          ),
        );
      });

      it('rejects scalar functions whose data sources bypass relation scope', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const statements = [
          "SELECT dictGet('missing_dictionary', 'value', id) FROM users",
          "SELECT joinGet('missing_join', 'value', id) FROM users",
        ];

        for (const sql of statements) {
          assert.equal(
            await adapter.validate(sql),
            'only SELECT queries allowed',
          );
          assert.ok(!databaseQueries.includes(sql));
        }
        assert.equal(validatorCalls, 0);
        assert.ok(
          !databaseQueries.some((sql) => sql.startsWith('EXPLAIN QUERY TREE')),
        );
      });

      it('validates a join when both resolved physical tables are grounded', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [
            tables({ filter: [`${DATABASE}.users`, `${DATABASE}.teams`] }),
          ],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = `
      SELECT u.name, t.name
      FROM users AS u
      JOIN teams AS t ON u.team_id = t.id
    `;

        assert.equal(await adapter.validate(sql), undefined);
        assert.equal(validatorCalls, 1);
      });

      it('validates ClickHouse-specific read clauses with known tree shapes', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = `
      SELECT team_id, count() AS total
      FROM users
      ARRAY JOIN [1] AS expanded
      PREWHERE id > 0
      WHERE name != ''
      GROUP BY team_id
      HAVING total > 0
      ORDER BY total DESC
      LIMIT 1 BY team_id
      LIMIT 10 OFFSET 0
    `;

        assert.equal(await adapter.validate(sql), undefined);
        assert.equal(validatorCalls, 1);
      });

      it('validates window functions and QUALIFY with known tree shapes', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = `
      SELECT
        id,
        row_number() OVER (PARTITION BY team_id ORDER BY id) AS rn
      FROM users
      QUALIFY rn = 1
    `;

        assert.equal(await adapter.validate(sql), undefined);
        assert.equal(validatorCalls, 1);
      });

      it('rejects an out-of-scope relation inside a union', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = 'SELECT id FROM users UNION ALL SELECT id FROM secrets';

        const result = await adapter.validate(sql);

        assert.equal(validatorCalls, 0);
        assert.ok(typeof result === 'string');
        assert.equal(JSON.parse(result).error_type, 'OUT_OF_SCOPE');
        assert.match(result, /secrets/);
      });

      it('compares physical relation names with ClickHouse case sensitivity', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });

        const result = await adapter.validate('SELECT * FROM Users');

        assert.equal(validatorCalls, 0);
        assert.ok(typeof result === 'string');
        assert.equal(JSON.parse(result).error_type, 'OUT_OF_SCOPE');
        assert.match(result, /analytics\.Users/);
      });

      it('qualifies unused syntactic relations with the effective database', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: ['archive.secrets'] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = `
      WITH hidden AS (SELECT * FROM secrets)
      SELECT * FROM archive.secrets
    `;

        const result = await adapter.validate(sql);

        assert.equal(validatorCalls, 0);
        assert.ok(typeof result === 'string');
        assert.equal(JSON.parse(result).error_type, 'OUT_OF_SCOPE');
        assert.match(result, /analytics\.secrets/);
      });

      it('rejects an out-of-scope relation inside a subquery', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [tables({ filter: [`${DATABASE}.users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });
        const sql = 'SELECT id FROM users WHERE id IN (SELECT id FROM secrets)';

        const result = await adapter.validate(sql);

        assert.equal(validatorCalls, 0);
        assert.ok(typeof result === 'string');
        assert.equal(JSON.parse(result).error_type, 'OUT_OF_SCOPE');
        assert.match(result, /secrets/);
      });

      it('validates a grounded view resolved in the default database', async () => {
        let validatorCalls = 0;
        const adapter = new ClickHouse({
          defaultDatabase: DATABASE,
          execute: query,
          grounding: [views({ filter: [`${DATABASE}.active_users`] })],
          validate: async () => {
            validatorCalls++;
          },
        });

        assert.equal(
          await adapter.validate('SELECT * FROM active_users'),
          undefined,
        );
        assert.equal(validatorCalls, 1);
      });
    },
  );
}
