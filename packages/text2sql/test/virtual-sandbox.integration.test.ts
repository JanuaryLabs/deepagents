import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { createVirtualSandbox } from '@deepagents/context';
import { Text2Sql, createSqlCommand } from '@deepagents/text2sql';
import { Sqlite, info, tables } from '@deepagents/text2sql/sqlite';

function buildSandbox() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);`);
  db.exec(`INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');`);

  const mem = new Sqlite({
    execute: (sql) => db.prepare(sql).all(),
    grounding: [tables(), info()],
  });

  const text2Sql = new Text2Sql({ adapters: { mem } });
  const { command } = createSqlCommand(text2Sql);
  return { command };
}

describe('createSqlCommand + createVirtualSandbox', () => {
  it('runs validate against the wrapped Text2Sql instance', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand(
      'sql validate mem "SELECT id, name FROM users"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'valid\n');
  });

  it('reports validation failures via stderr with exit 1 and trailing newline', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand(
      'sql validate mem "SELECT bogus FROM nope"',
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^sql validate: .+\n$/);
  });

  it('reports unknown databases with the available list', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql run wrong "SELECT 1"');

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unknown database "wrong"/);
    assert.match(result.stderr, /Available: mem/);
    assert.ok(result.stderr.endsWith('\n'));
  });

  it('runs queries, writes results to ctx.fs, and prints summary', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand(
      'sql run mem "SELECT id, name FROM users ORDER BY id"',
    );

    assert.equal(result.exitCode, 0, result.stderr);

    const match = result.stdout.match(/^results stored in (\S+)\n/);
    assert.ok(match, `expected manifest stdout, got: ${result.stdout}`);
    const outPath = match[1];

    assert.match(result.stdout, /columns: id, name\n/);
    assert.match(result.stdout, /rows: 2\n/);

    const stored = await sandbox.readFile(outPath);
    const rows = JSON.parse(stored);
    assert.deepEqual(rows, [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('honors --out-dir override', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand(
      'sql run mem --out-dir /tmp/queries "SELECT 1 AS one"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(
      /^results stored in (\/tmp\/queries\/\S+)\n/,
    );
    assert.ok(match, `expected /tmp/queries/... path, got: ${result.stdout}`);
  });

  it('honors $TEXT2SQL_OUT_DIR env from the sandbox', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      env: { TEXT2SQL_OUT_DIR: '/data' },
      customCommands: [command],
    });

    const result = await sandbox.executeCommand(
      'sql run mem "SELECT 1 AS one"',
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^results stored in \/data\//);
  });

  it('runs index, writes fragments JSON to ctx.fs, and prints manifest', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql index');

    assert.equal(result.exitCode, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.eventsPath, null);
    assert.deepEqual(manifest.adapters, ['mem']);
    assert.ok(manifest.fragments > 0);
    assert.ok(manifest.fragmentsPath.startsWith('/sql/index-'));

    const fragmentsJson = await sandbox.readFile(manifest.fragmentsPath);
    const fragments = JSON.parse(fragmentsJson);
    assert.ok(Array.isArray(fragments));
    assert.ok(fragments.length > 0);
  });

  it('rejects unknown adapters passed to sql index', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql index nope');

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /unknown adapter "nope"/);
    assert.ok(result.stderr.endsWith('\n'));
  });

  it('treats --all as winning over positionals (matches bin contract)', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql index --all bogus');

    assert.equal(result.exitCode, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest.adapters, ['mem']);
  });

  it('reports --out-dir without a value via parseArgs', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql index --out-dir');

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /^sql index: /);
    assert.match(result.stderr, /--out-dir/);
    assert.ok(result.stderr.endsWith('\n'));
  });

  it('prints usage with no subcommand', async () => {
    const { command } = buildSandbox();
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [command],
    });

    const result = await sandbox.executeCommand('sql');

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Usage:/);
    assert.match(result.stderr, /sql run/);
    assert.match(result.stderr, /sql validate/);
    assert.match(result.stderr, /sql index/);
  });
});
