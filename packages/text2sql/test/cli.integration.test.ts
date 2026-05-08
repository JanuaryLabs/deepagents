import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const BIN = path.join(PKG_ROOT, 'dist', 'bin', 'sql.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'cli-adapters.ts');

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunOpts {
  cwd: string;
  adaptersPath?: string | null;
}

async function runBin(args: string[], opts: RunOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.adaptersPath === null) {
      delete env.TEXT2SQL_ADAPTERS;
    } else {
      env.TEXT2SQL_ADAPTERS = opts.adaptersPath ?? FIXTURE;
    }

    const child = spawn('node', ['--no-warnings', BIN, ...args], {
      cwd: opts.cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
}

function makeTmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'sql-cli-test-'));
}

describe('sql binary', () => {
  it('run: writes rows to ./sql/<uuid>.json and prints metadata', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['run', 'mem', 'SELECT id, name FROM users ORDER BY id'],
      { cwd },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      /^results stored in \.\/sql\/[a-f0-9-]+\.json\ncolumns: id, name\nrows: 2\n$/,
    );

    const sqlDir = path.join(cwd, 'sql');
    const files = readdirSync(sqlDir);
    assert.equal(files.length, 1);
    const content = JSON.parse(
      readFileSync(path.join(sqlDir, files[0]), 'utf-8'),
    );
    assert.deepStrictEqual(content, [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('run: read-only enforcement rejects INSERT', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['run', 'mem', "INSERT INTO users (id, name) VALUES (3, 'Carol')"],
      { cwd },
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /sql run:/);
    assert.match(result.stderr, /only SELECT or WITH queries allowed/);
  });

  it('run: invalid SQL syntax exits non-zero', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', 'SELECT FROM users WHERE'], {
      cwd,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /sql run:/);
    assert.match(
      result.stderr,
      /SQL_SCOPE_PARSE_ERROR|SYNTAX_ERROR|syntax error/,
    );
  });

  it('validate: happy path exits 0 and prints "valid"', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', 'mem', 'SELECT id FROM users'], {
      cwd,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'valid\n');
  });

  it('validate: bad SQL exits non-zero with stderr', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', 'mem', 'SELECT FROM'], { cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /sql validate:/);
  });

  it('errors: missing TEXT2SQL_ADAPTERS env var', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath: null,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /TEXT2SQL_ADAPTERS/);
  });

  it('errors: adapter module import failure', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath: path.join(cwd, 'missing-adapters.ts'),
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /failed to import module/);
  });

  it('errors: empty adapter module default export', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = path.join(cwd, 'empty-adapters.ts');
    writeFileSync(adaptersPath, 'export default {};');

    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /default export is an empty object/);
  });

  it('errors: malformed adapter value', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = path.join(cwd, 'bad-adapters.ts');
    writeFileSync(adaptersPath, 'export default { bad: { format() {} } };');

    const result = await runBin(['run', 'bad', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /adapter "bad" is missing one of the required methods/,
    );
  });

  it('errors: unknown db name lists available adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'nonexistent', 'SELECT 1 as n'], {
      cwd,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unknown database "nonexistent"/);
    assert.match(result.stderr, /Available: mem/);
  });

  it('errors: unknown subcommand', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['ask', 'mem', 'SELECT 1'], { cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /unknown subcommand "ask"/);
  });

  it('errors: missing db arg', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run'], { cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /missing database name/);
  });

  it('errors: missing sql arg', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem'], { cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /no query provided/);
  });
});
