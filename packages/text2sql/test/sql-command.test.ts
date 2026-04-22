import assert from 'node:assert';
import { describe, it } from 'node:test';

import { sqlSandboxExtension } from '@deepagents/text2sql';

import { init_db } from '../src/tests/sqlite.ts';
import { buildSandbox } from './helpers/build-sandbox.ts';

describe('sqlSandboxExtension: non-array adapter result', () => {
  it('sql run surfaces an error when adapter.execute returns a non-array', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);
    // Swap in an execute() that returns an object instead of an array.
    (adapter as unknown as { execute: (sql: string) => unknown }).execute =
      () => ({ rows: [{ n: 1 }] }) as unknown;

    const sandbox = await buildSandbox([sqlSandboxExtension(adapter)]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run "SELECT 1 AS n"`,
    );
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /adapter\.execute must return an array/);
  });
});

describe('sqlSandboxExtension: outputDir option', () => {
  it('writes results to a custom output directory', async () => {
    const { adapter } = await init_db(`CREATE TABLE t (n INTEGER);`);

    const sandbox = await buildSandbox([
      sqlSandboxExtension(adapter, { outputDir: '/tmp/out' }),
    ]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run "SELECT 1 AS n"`,
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

    const sandbox = await buildSandbox([sqlSandboxExtension(adapter)]);

    const result = await sandbox.sandbox.executeCommand(
      `sql run "SELECT 1 AS n"`,
    );
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /results stored in \/sql\//);
  });
});
