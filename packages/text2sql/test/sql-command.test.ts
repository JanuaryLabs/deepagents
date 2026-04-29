import assert from 'node:assert';
import { describe, it } from 'node:test';

import { sqlSandboxExtension } from '@deepagents/text2sql';
import * as sqlite from '@deepagents/text2sql/sqlite';

import { init_db } from '../src/tests/sqlite.ts';
import { buildSandbox } from './helpers/build-sandbox.ts';

describe('sqlSandboxExtension: non-array adapter result', () => {
  it('sql run surfaces an error when adapter.execute returns a non-array', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);
    (adapter as unknown as { execute: (sql: string) => unknown }).execute =
      () => ({ rows: [{ n: 1 }] }) as unknown;

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run main "SELECT 1 AS n"`,
    );
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /adapter\.execute must return an array/);
  });
});

describe('sqlSandboxExtension: outputDir option', () => {
  it('writes results to a custom output directory', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }, { outputDir: '/tmp/out' }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run main "SELECT 1 AS n"`,
    );
    assert.strictEqual(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(/results stored in (\S+)/);
    assert.ok(
      match,
      `expected 'results stored in <path>', got ${result.stdout}`,
    );
    const storedPath = match![1];
    assert.ok(
      storedPath.startsWith('/tmp/out/') && storedPath.endsWith('.json'),
      `expected path under /tmp/out/, got ${storedPath}`,
    );

    const content = await sandbox.sandbox.readFile(storedPath);
    assert.deepStrictEqual(JSON.parse(content), [{ n: 1 }]);
  });

  it('defaults outputDir to /sql when not provided', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run main "SELECT 1 AS n"`,
    );
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /results stored in \/sql\//);
  });
});

describe('sqlSandboxExtension: multi-adapter routing', () => {
  it('routes queries to the named adapter', async () => {
    const { adapter: mainAdapter } = await init_db(
      `CREATE TABLE users (id INTEGER);
       INSERT INTO users VALUES (1), (2);`,
      { grounding: [sqlite.tables()] },
    );
    const { adapter: analyticsAdapter } = await init_db(
      `CREATE TABLE events (id INTEGER);
       INSERT INTO events VALUES (10), (20), (30);`,
      { grounding: [sqlite.tables()] },
    );

    const sandbox = await buildSandbox([
      sqlSandboxExtension({
        main: mainAdapter,
        analytics: analyticsAdapter,
      }),
    ]);

    const mainResult = await sandbox.sandbox.executeCommand(
      `sql run main "SELECT COUNT(*) AS c FROM users"`,
    );
    assert.strictEqual(mainResult.exitCode, 0, mainResult.stderr);
    const mainMatch = mainResult.stdout.match(/results stored in (\S+)/);
    const mainRows = JSON.parse(await sandbox.sandbox.readFile(mainMatch![1]));
    assert.deepStrictEqual(mainRows, [{ c: 2 }]);

    const analyticsResult = await sandbox.sandbox.executeCommand(
      `sql run analytics "SELECT COUNT(*) AS c FROM events"`,
    );
    assert.strictEqual(analyticsResult.exitCode, 0, analyticsResult.stderr);
    const analyticsMatch = analyticsResult.stdout.match(
      /results stored in (\S+)/,
    );
    const analyticsRows = JSON.parse(
      await sandbox.sandbox.readFile(analyticsMatch![1]),
    );
    assert.deepStrictEqual(analyticsRows, [{ c: 3 }]);
  });

  it('rejects unknown database name with a clean error', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run bogus "SELECT 1"`,
    );
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /unknown database "bogus"/);
    assert.match(result.stderr, /Available: main/);
  });

  it('rejects missing database name', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(`sql run`);
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /missing database name/);
  });

  it('validates adapter names at extension construction time', () => {
    const adapter = {} as never;
    assert.throws(
      () => sqlSandboxExtension({ 'bad name': adapter }),
      /Invalid adapter name/,
    );
  });

  it('rejects empty adapter map', () => {
    assert.throws(() => sqlSandboxExtension({}), /at least one adapter/);
  });
});

describe('sqlSandboxExtension: backtick rewrite with db name', () => {
  it('rewrites backtick SQL when db name is a valid identifier', async () => {
    const { adapter } = await init_db(
      `CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);`,
      { grounding: [sqlite.tables()] },
    );

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      'sql run main "SELECT `n` FROM t"',
    );
    assert.strictEqual(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(/results stored in (\S+)/);
    const rows = JSON.parse(await sandbox.sandbox.readFile(match![1]));
    assert.deepStrictEqual(rows, [{ n: 1 }]);
  });

  it('does not rewrite when db name is not a valid identifier', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`, {
      grounding: [sqlite.tables()],
    });

    const sandbox = await buildSandbox([
      sqlSandboxExtension({ main: adapter }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      'sql run "foo bar" "SELECT `n` FROM t"',
    );
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /unknown database "foo bar"/);
  });
});
