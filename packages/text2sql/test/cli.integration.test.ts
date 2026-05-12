import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  XmlRenderer,
} from '@deepagents/context';

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
  outDirEnv?: string;
  eventsPathEnv?: string;
}

interface IndexManifest {
  fragmentsPath: string;
  eventsPath: string;
  adapters: string[];
  fragments: number;
}

function buildEnv(opts: RunOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.adaptersPath === null) {
    delete env.TEXT2SQL_ADAPTERS;
  } else {
    env.TEXT2SQL_ADAPTERS = opts.adaptersPath ?? FIXTURE;
  }
  if (opts.outDirEnv !== undefined) {
    env.TEXT2SQL_OUT_DIR = opts.outDirEnv;
  } else {
    delete env.TEXT2SQL_OUT_DIR;
  }
  if (opts.eventsPathEnv !== undefined) {
    env.TEXT2SQL_INDEX_EVENTS_PATH = opts.eventsPathEnv;
  } else {
    delete env.TEXT2SQL_INDEX_EVENTS_PATH;
  }
  return env;
}

async function runBin(args: string[], opts: RunOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--no-warnings', BIN, ...args], {
      cwd: opts.cwd,
      env: buildEnv(opts),
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

const POSIX = process.platform !== 'win32';

function mkfifo(p: string): void {
  const result = spawnSync('mkfifo', [p]);
  if (result.status !== 0) {
    throw new Error(
      `mkfifo ${p} failed: ${result.stderr?.toString() ?? 'unknown'}`,
    );
  }
}

function readFifo(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const stream = createReadStream(p, { encoding: 'utf-8' });
    stream.on('data', (chunk) => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function ndjsonTypes(raw: string): string[] {
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeAdaptersModule(
  cwd: string,
  source: string,
  filename = 'adapters.ts',
): string {
  const adaptersPath = path.join(cwd, filename);
  writeFileSync(adaptersPath, source);
  return adaptersPath;
}

function distFileUrl(...parts: string[]): string {
  return pathToFileURL(path.join(PKG_ROOT, 'dist', ...parts)).href;
}

function sourceFileUrl(...parts: string[]): string {
  return pathToFileURL(path.join(PKG_ROOT, 'src', ...parts)).href;
}

function parseIndexManifest(result: SpawnResult): IndexManifest {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as IndexManifest;
}

function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf-8')) as T;
}

function readEvents(
  file: string,
): Array<{ type: string; timestampMs?: number }> {
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; timestampMs?: number });
}

function assertManifestFiles(cwd: string, manifest: IndexManifest): void {
  const sqlDir = path.join(realpathSync(cwd), 'sql');
  assert.ok(path.isAbsolute(manifest.fragmentsPath));
  assert.ok(path.isAbsolute(manifest.eventsPath));
  assert.ok(
    manifest.fragmentsPath.startsWith(sqlDir + path.sep),
    `expected fragments path under ${sqlDir}, got ${manifest.fragmentsPath}`,
  );
  assert.ok(
    manifest.eventsPath.startsWith(sqlDir + path.sep),
    `expected events path under ${sqlDir}, got ${manifest.eventsPath}`,
  );
  assert.ok(existsSync(manifest.fragmentsPath));
  assert.ok(existsSync(manifest.eventsPath));
  assert.deepEqual(
    readdirSync(sqlDir).sort(),
    [
      path.basename(manifest.eventsPath),
      path.basename(manifest.fragmentsPath),
    ].sort(),
  );
}

describe('sql binary', () => {
  it('run: writes rows under cwd/sql by default and prints metadata', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['run', 'mem', 'SELECT id, name FROM users ORDER BY id'],
      { cwd },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    const sqlDir = path.join(realpathSync(cwd), 'sql');
    const expected = new RegExp(
      `^results stored in ${escapeRegExp(sqlDir)}/[a-f0-9-]+\\.json\\ncolumns: id, name\\nrows: 2\\n$`,
    );
    assert.match(result.stdout, expected);

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

  it('run: --out-dir flag writes to the supplied path', async () => {
    const cwd = makeTmpDir();
    const outDir = path.join(makeTmpDir(), 'nested');
    const result = await runBin(
      ['--out-dir', outDir, 'run', 'mem', 'SELECT id FROM users ORDER BY id'],
      { cwd },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(/results stored in (\S+)/);
    assert.ok(
      match,
      `expected 'results stored in <path>', got ${result.stdout}`,
    );
    assert.ok(
      match[1].startsWith(outDir + path.sep),
      `expected path under ${outDir}, got ${match[1]}`,
    );
    assert.equal(readdirSync(outDir).length, 1);
  });

  it('run: TEXT2SQL_OUT_DIR env redirects writes', async () => {
    const cwd = makeTmpDir();
    const outDir = path.join(makeTmpDir(), 'env-out');
    const result = await runBin(['run', 'mem', 'SELECT id FROM users'], {
      cwd,
      outDirEnv: outDir,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`^results stored in ${escapeRegExp(outDir)}/`),
    );
    assert.equal(readdirSync(outDir).length, 1);
  });

  it('run: --out-dir flag wins over TEXT2SQL_OUT_DIR env', async () => {
    const cwd = makeTmpDir();
    const envDir = path.join(makeTmpDir(), 'env-dir');
    const flagDir = path.join(makeTmpDir(), 'flag-dir');
    const result = await runBin(
      ['--out-dir', flagDir, 'run', 'mem', 'SELECT id FROM users'],
      { cwd, outDirEnv: envDir },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`^results stored in ${escapeRegExp(flagDir)}/`),
    );
    assert.equal(readdirSync(flagDir).length, 1);
  });

  it('run: --out-dir can be provided after the subcommand', async () => {
    const cwd = makeTmpDir();
    const outDir = path.join(makeTmpDir(), 'post-command-out');
    const result = await runBin(
      ['run', 'mem', 'SELECT id FROM users', '--out-dir', outDir],
      { cwd },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`^results stored in ${escapeRegExp(outDir)}/`),
    );
    assert.equal(readdirSync(outDir).length, 1);
  });

  it('run: empty result sets print no columns and rows 0', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['run', 'mem', 'SELECT id FROM users WHERE 0'],
      {
        cwd,
      },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /\ncolumns: \(none\)\nrows: 0\n$/);
  });

  it('run: adapter execute errors are reported as run failures', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => null,
          execute: async () => { throw new Error('database exploded'); },
        },
      };`,
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql run: database exploded/);
  });

  it('run: non-Error execute throws are reported as run failures', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => null,
          execute: async () => { throw 'plain failure'; },
        },
      };`,
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /sql run: plain failure/);
  });

  it('run: non-array execute results are rejected', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => null,
          execute: async () => ({ id: 1 }),
        },
      };`,
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      /sql run: adapter\.execute must return an array of rows/,
    );
  });

  it('run: routes queries to the requested adapter', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `const adapter = (rows) => ({
        format: (sql) => sql,
        validate: async () => null,
        execute: async () => rows,
      });
      export default {
        main: adapter([{ source: 'main', c: 2 }]),
        analytics: adapter([{ source: 'analytics', c: 3 }]),
      };`,
      'run-routing-adapters.ts',
    );

    const main = await runBin(['run', 'main', 'SELECT COUNT(*) AS c'], {
      cwd,
      adaptersPath,
    });
    const analytics = await runBin(
      ['run', 'analytics', 'SELECT COUNT(*) AS c'],
      { cwd, adaptersPath },
    );

    assert.equal(main.exitCode, 0, main.stderr);
    assert.equal(analytics.exitCode, 0, analytics.stderr);

    const mainPath = main.stdout.match(/results stored in (\S+)/)?.[1];
    const analyticsPath = analytics.stdout.match(
      /results stored in (\S+)/,
    )?.[1];
    assert.ok(mainPath, `expected main result path, got ${main.stdout}`);
    assert.ok(
      analyticsPath,
      `expected analytics result path, got ${analytics.stdout}`,
    );
    assert.deepStrictEqual(readJsonFile(mainPath), [{ source: 'main', c: 2 }]);
    assert.deepStrictEqual(readJsonFile(analyticsPath), [
      { source: 'analytics', c: 3 },
    ]);
  });

  it('run: adapter format output is validated and executed', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql + ' formatted',
          validate: async (sql) => sql.endsWith(' formatted') ? null : 'not formatted',
          execute: async (sql) => [{ sql }],
        },
      };`,
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(/results stored in (\S+)/);
    assert.ok(match, `expected result path, got ${result.stdout}`);
    const content = JSON.parse(readFileSync(match[1], 'utf-8'));
    assert.deepStrictEqual(content, [{ sql: 'SELECT 1 formatted' }]);
  });

  it('run: supports literal backtick identifiers in SQL argv', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['run', 'mem', 'SELECT `name` FROM users ORDER BY id'],
      { cwd },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    const match = result.stdout.match(/results stored in (\S+)/);
    assert.ok(match, `expected result path, got ${result.stdout}`);
    assert.deepStrictEqual(readJsonFile(match[1]), [
      { name: 'Alice' },
      { name: 'Bob' },
    ]);
  });

  it('run: adapter format errors are reported as run failures', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: () => { throw new Error('formatter exploded'); },
          validate: async () => null,
          execute: async () => [],
        },
      };`,
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql run: formatter exploded/);
    assert.doesNotMatch(result.stderr, /unexpected error/);
  });

  it('run: blank queries are rejected after argv parsing', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', '   '], { cwd });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql run: no query provided/);
  });

  it('run: output write failures are reported as run failures', async () => {
    const cwd = makeTmpDir();
    const outDir = path.join(cwd, 'not-a-directory');
    writeFileSync(outDir, 'file');

    const result = await runBin(
      ['--out-dir', outDir, 'run', 'mem', 'SELECT id FROM users'],
      { cwd },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /sql run:/);
    assert.match(result.stderr, /EEXIST|ENOTDIR/);
    assert.doesNotMatch(result.stderr, /unexpected error/);
  });

  it('index: indexes all adapters by default and writes a JSON manifest', async () => {
    const cwd = makeTmpDir();
    const manifest = parseIndexManifest(await runBin(['index'], { cwd }));

    assert.deepEqual(manifest.adapters, ['mem']);
    assert.ok(manifest.fragments > 0);
    assertManifestFiles(cwd, manifest);

    const fragments = readJsonFile<ContextFragment[]>(manifest.fragmentsPath);
    assert.equal(fragments.length, 1);
    assert.equal(fragments[0].name, 'mem');
  });

  it('index: --all matches the default behavior', async () => {
    const defaultCwd = makeTmpDir();
    const explicitCwd = makeTmpDir();
    const defaultManifest = parseIndexManifest(
      await runBin(['index'], { cwd: defaultCwd }),
    );
    const explicitManifest = parseIndexManifest(
      await runBin(['index', '--all'], { cwd: explicitCwd }),
    );

    assert.deepEqual(explicitManifest.adapters, defaultManifest.adapters);
    assert.equal(explicitManifest.fragments, defaultManifest.fragments);
    assert.deepEqual(
      readJsonFile<ContextFragment[]>(explicitManifest.fragmentsPath),
      readJsonFile<ContextFragment[]>(defaultManifest.fragmentsPath),
    );
  });

  it('index: adapter names limit indexing to those adapters', async () => {
    const cwd = makeTmpDir();
    const manifest = parseIndexManifest(
      await runBin(['index', 'mem'], { cwd }),
    );
    const fragments = readJsonFile<ContextFragment[]>(manifest.fragmentsPath);

    assert.deepEqual(manifest.adapters, ['mem']);
    assert.deepEqual(
      fragments.map((fragment) => fragment.name),
      ['mem'],
    );
  });

  it('index: duplicate adapter names are indexed once', async () => {
    const cwd = makeTmpDir();
    const manifest = parseIndexManifest(
      await runBin(['index', 'mem', 'mem'], { cwd }),
    );
    const fragments = readJsonFile<ContextFragment[]>(manifest.fragmentsPath);

    assert.deepEqual(manifest.adapters, ['mem']);
    assert.deepEqual(
      fragments.map((fragment) => fragment.name),
      ['mem'],
    );
  });

  it('index: --all indexes every adapter even when names are provided', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `const adapter = (label) => ({
        format: (sql) => sql,
        validate: async () => null,
        execute: async () => [],
        introspect: async () => [{ name: label + '-schema', data: ['table ' + label] }],
      });
      export default { alpha: adapter('alpha'), beta: adapter('beta') };`,
      'multi-adapters.ts',
    );

    const manifest = parseIndexManifest(
      await runBin(['index', '--all', 'alpha'], { cwd, adaptersPath }),
    );
    const fragments = readJsonFile<ContextFragment[]>(manifest.fragmentsPath);

    assert.deepEqual(manifest.adapters, ['alpha', 'beta']);
    assert.equal(manifest.fragments, 2);
    assert.deepEqual(
      fragments.map((fragment) => fragment.name),
      ['alpha', 'beta'],
    );
  });

  it('index: unknown adapter fails with available adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index', 'missing'], { cwd });

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql index: unknown adapter "missing"/);
    assert.match(result.stderr, /Available: mem/);
  });

  it('index: events file is NDJSON with index, adapter, and phase events', async () => {
    const cwd = makeTmpDir();
    const manifest = parseIndexManifest(await runBin(['index'], { cwd }));
    const events = readEvents(manifest.eventsPath);
    const types = events.map((event) => event.type);

    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('adapter:start'));
    assert.ok(types.includes('phase:start'));
    assert.ok(types.includes('phase:progress'));
    assert.ok(types.includes('phase:end'));
    assert.ok(types.includes('adapter:end'));
    assert.ok(types.includes('index:end'));
    assert.ok(events.every((event) => typeof event.timestampMs === 'number'));
  });

  it('index: TEXT2SQL_INDEX_EVENTS_PATH redirects the events stream to a chosen path', async () => {
    const cwd = makeTmpDir();
    const listenerDir = realpathSync(makeTmpDir());
    const eventsPath = path.join(listenerDir, 'nested', 'live.ndjson');

    const result = await runBin(['index'], { cwd, eventsPathEnv: eventsPath });
    const manifest = parseIndexManifest(result);

    assert.equal(manifest.eventsPath, eventsPath);
    assert.ok(existsSync(eventsPath));

    const raw = readFileSync(eventsPath, 'utf-8');
    assert.ok(
      raw.endsWith('\n'),
      'events file should end with a newline — proves last event was flushed',
    );

    const events = readEvents(eventsPath);
    const types = events.map((event) => event.type);
    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('index:end'));

    const sqlDir = path.join(realpathSync(cwd), 'sql');
    const sqlDirEntries = readdirSync(sqlDir);
    assert.ok(
      sqlDirEntries.every((entry) => !entry.endsWith('.events.ndjson')),
      `default sql dir should not contain an events file when TEXT2SQL_INDEX_EVENTS_PATH is set, got: ${sqlDirEntries.join(', ')}`,
    );
  });

  it('index: TEXT2SQL_INDEX_EVENTS_PATH resolves relative paths against cwd', async () => {
    const cwd = makeTmpDir();
    const relative = path.join('live', 'events.ndjson');
    const expected = path.join(realpathSync(cwd), relative);

    const result = await runBin(['index'], { cwd, eventsPathEnv: relative });
    const manifest = parseIndexManifest(result);

    assert.equal(manifest.eventsPath, expected);
    assert.ok(existsSync(expected));
    assert.ok(readEvents(expected).some((event) => event.type === 'index:end'));
  });

  it('index: empty TEXT2SQL_INDEX_EVENTS_PATH falls back to the auto-generated path', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index'], { cwd, eventsPathEnv: '' });
    const manifest = parseIndexManifest(result);
    assertManifestFiles(cwd, manifest);
    assert.match(
      path.basename(manifest.eventsPath),
      /^index-[a-f0-9-]+\.events\.ndjson$/,
    );
  });

  it('index: TEXT2SQL_INDEX_EVENTS_PATH appends to a pre-existing regular file without a FIFO warning', async () => {
    const cwd = makeTmpDir();
    const eventsPath = path.join(
      realpathSync(makeTmpDir()),
      'pre-existing.ndjson',
    );
    writeFileSync(eventsPath, '{"type":"prelude"}\n');

    const result = await runBin(['index'], { cwd, eventsPathEnv: eventsPath });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /waiting for reader on FIFO/);

    const types = ndjsonTypes(readFileSync(eventsPath, 'utf-8'));
    assert.equal(types[0], 'prelude', 'append must preserve prior contents');
    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('index:end'));
  });

  it('index: FIFO with reader attached streams events through with no warning', async (t) => {
    if (!POSIX) {
      t.skip('mkfifo is POSIX-only');
      return;
    }
    const cwd = makeTmpDir();
    const fifoPath = path.join(realpathSync(makeTmpDir()), 'live.ndjson');
    mkfifo(fifoPath);

    const readerPromise = readFifo(fifoPath);
    const result = await runBin(['index'], { cwd, eventsPathEnv: fifoPath });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(
      result.stderr,
      /waiting for reader on FIFO/,
      'no warning expected when reader is already attached',
    );

    const types = ndjsonTypes(await readerPromise);
    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('index:end'));

    const manifest = JSON.parse(result.stdout) as IndexManifest;
    assert.equal(manifest.eventsPath, fifoPath);
  });

  it('index: FIFO with no reader warns on stderr, unblocks once a reader attaches', async (t) => {
    if (!POSIX) {
      t.skip('mkfifo is POSIX-only');
      return;
    }
    const cwd = makeTmpDir();
    const fifoPath = path.join(realpathSync(makeTmpDir()), 'live.ndjson');
    mkfifo(fifoPath);

    const child = spawn('node', ['--no-warnings', BIN, 'index'], {
      cwd,
      env: buildEnv({ cwd, eventsPathEnv: fifoPath }),
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    const sawWarning = new Promise<void>((resolve) => {
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.includes('waiting for reader on FIFO')) resolve();
      });
    });

    await sawWarning;
    const readerData = readFifo(fifoPath);
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 0));
    });

    assert.equal(exitCode, 0, stderr);
    assert.match(
      stderr,
      new RegExp(`waiting for reader on FIFO ${escapeRegExp(fifoPath)}`),
    );

    const types = ndjsonTypes(await readerData);
    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('index:end'));

    const manifest = JSON.parse(stdout) as IndexManifest;
    assert.equal(manifest.eventsPath, fifoPath);
  });

  it('index: stderr is silent without --verbose', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index'], { cwd });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
  });

  it('index: --verbose mirrors pretty progress lines to stderr without polluting stdout', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index', '--verbose'], { cwd });
    assert.equal(result.exitCode, 0, result.stderr);

    const manifest = JSON.parse(result.stdout) as IndexManifest;
    assert.deepEqual(manifest.adapters, ['mem']);

    const lines = result.stderr.trim().split('\n');
    assert.ok(lines.some((line) => line.startsWith('[index:start]')));
    assert.ok(
      lines.some((line) => /^\[adapter:start mem\]/.test(line)),
      `expected adapter:start line, got:\n${result.stderr}`,
    );
    assert.ok(lines.some((line) => /^\[phase:progress mem\]/.test(line)));
    assert.ok(lines.some((line) => line.startsWith('[index:end]')));
  });

  it('index: --verbose=json mirrors raw NDJSON events to stderr', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index', '--verbose', 'json'], { cwd });
    assert.equal(result.exitCode, 0, result.stderr);

    const events = result.stderr
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; timestampMs: number });

    const types = events.map((event) => event.type);
    assert.ok(types.includes('index:start'));
    assert.ok(types.includes('index:end'));
    assert.ok(events.every((event) => typeof event.timestampMs === 'number'));
  });

  it('index: --verbose with invalid format fails with helpful message', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index', '--verbose', 'garbage'], { cwd });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /sql index: invalid --verbose value "garbage"/);
    assert.match(result.stderr, /Expected "pretty" or "json"/);
  });

  it('index: introspection failures are reported and recorded as events', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => null,
          execute: async () => [],
          introspect: async () => { throw new Error('metadata unavailable'); },
        },
      };`,
      'failing-index-adapters.ts',
    );

    const result = await runBin(['index'], { cwd, adaptersPath });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /sql index: introspecting adapter "mem": metadata unavailable/,
    );

    const sqlDir = path.join(realpathSync(cwd), 'sql');
    const files = readdirSync(sqlDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /\.events\.ndjson$/);
    const events = readEvents(path.join(sqlDir, files[0]));
    const types = events.map((event) => event.type);
    assert.ok(types.includes('adapter:error'));
    assert.ok(types.includes('index:error'));
    assert.ok(!types.includes('index:end'));
  });

  it('index: output write failures are reported as index failures', async () => {
    const cwd = makeTmpDir();
    writeFileSync(path.join(cwd, 'sql'), 'file');

    const result = await runBin(['index'], { cwd });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql index:/);
    assert.match(result.stderr, /EEXIST|ENOTDIR/);
    assert.doesNotMatch(result.stderr, /unexpected error/);
  });

  it('index: fragments file is usable as context fragments', async () => {
    const cwd = makeTmpDir();
    const manifest = parseIndexManifest(await runBin(['index'], { cwd }));
    const fragments = readJsonFile<ContextFragment[]>(manifest.fragmentsPath);
    const engine = new ContextEngine({
      chatId: 'cli-index-test',
      userId: 'test-user',
      store: new InMemoryContextStore(),
    });

    engine.set(...fragments);
    const resolved = await engine.resolve({ renderer: new XmlRenderer() });
    assert.match(resolved.systemPrompt, /users/);
  });

  it('errors: --out-dir without value', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', 'SELECT 1', '--out-dir'], {
      cwd,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /option `--out-dir <path>` value is missing/);
  });

  it('errors: unknown subcommand', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['ask', 'mem', 'SELECT 1'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /unknown subcommand "ask"/);
  });

  it('errors: unknown global option without a subcommand', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['--bad-option'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Unknown option `--badOption`/);
  });

  it('errors: unknown option on a matched command', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem', 'SELECT 1', '--bad-option'], {
      cwd,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Unknown option `--badOption`/);
  });

  it('errors: missing subcommand', async () => {
    const cwd = makeTmpDir();
    const result = await runBin([], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /missing subcommand/);
  });

  it('--help lists run and validate subcommands with descriptions', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['--help'], { cwd, adaptersPath: null });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /run <db> "SELECT \.\.\."/);
    assert.match(result.stdout, /validate <db> "SELECT \.\.\."/);
    assert.match(
      result.stdout,
      /index \[--all\] \[--verbose\] \[adapter \.\.\.\]/,
    );
    assert.match(result.stdout, /Execute query against <db> and store results/);
    assert.match(result.stdout, /Validate query syntax against <db>/);
    assert.match(
      result.stdout,
      /Index adapter schemas and write context artifacts/,
    );
  });

  it('run --help prints command-specific usage without loading adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', '--help'], { cwd, adaptersPath: null });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage:\n\s+\$ sql <db> "SELECT \.\.\."/);
    assert.match(result.stdout, /--out-dir <path>/);
  });

  it('validate --help prints command-specific usage without loading adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', '--help'], {
      cwd,
      adaptersPath: null,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Usage:\n\s+\$ sql <db> "SELECT \.\.\."/);
  });

  it('index --help prints command-specific usage without loading adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index', '--help'], {
      cwd,
      adaptersPath: null,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, '');
    assert.match(
      result.stdout,
      /Usage:\n\s+\$ sql \[--all\] \[--verbose \[pretty\|json\]\] \[adapter \.\.\.\]/,
    );
    assert.match(result.stdout, /--all\s+Index all adapters \(default\)/);
    assert.match(
      result.stdout,
      /-v, --verbose \[format\]\s+Mirror progress events to stderr/,
    );
  });

  it('validate: query can be passed as multiple argv parts', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['validate', 'mem', 'SELECT', 'id', 'FROM', 'users'],
      { cwd },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'valid\n');
  });

  it('validate: read-only enforcement rejects INSERT', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(
      ['validate', 'mem', "INSERT INTO users (id, name) VALUES (3, 'Carol')"],
      { cwd },
    );
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /sql validate:/);
    assert.match(result.stderr, /only SELECT or WITH queries allowed/);
  });

  it('validate: runtime scope enforcement rejects out-of-scope tables', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `import { tables } from '${distFileUrl('lib/adapters/sqlite/index.js')}';
       import { init_db } from '${sourceFileUrl('tests/sqlite.ts')}';

       const { adapter: mem } = await init_db(
         'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
         { grounding: [tables({ filter: ['users'] })] },
       );

       export default { mem };`,
      'scoped-adapters.ts',
    );

    const result = await runBin(['validate', 'mem', 'SELECT * FROM secrets'], {
      cwd,
      adaptersPath,
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /sql validate:/);
    assert.match(result.stderr, /OUT_OF_SCOPE|outside grounded scope/);
  });

  it('validate: adapter format output is validated', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql + ' formatted',
          validate: async (sql) => sql.endsWith(' formatted') ? null : 'not formatted',
          execute: async () => { throw new Error('validate must not execute'); },
        },
      };`,
    );

    const result = await runBin(['validate', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'valid\n');
  });

  it('validate: adapter validation errors are reported as validate failures', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => { throw new Error('validator exploded'); },
          execute: async () => { throw new Error('validate must not execute'); },
        },
      };`,
    );

    const result = await runBin(['validate', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql validate: validator exploded/);
    assert.doesNotMatch(result.stderr, /unexpected error/);
  });

  it('validate: blank queries are rejected after argv parsing', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', 'mem', '   '], { cwd });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /sql validate: no query provided/);
  });

  it('validate: unknown db name lists available adapters', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', 'nonexistent', 'SELECT 1 as n'], {
      cwd,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /sql validate: unknown database "nonexistent"/);
    assert.match(result.stderr, /Available: mem/);
  });

  it('validate: missing db arg is rejected by the parser', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /missing required args for command `validate <db> <\.\.\.sql>`/,
    );
  });

  it('validate: missing sql arg is rejected by the parser', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['validate', 'mem'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /missing required args for command `validate <db> <\.\.\.sql>`/,
    );
  });

  it('errors: adapter module with invalid name fails to load', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `const adapter = { format: (s) => s, validate: async () => null, execute: async () => [] };
       export default { 'bad name': adapter };`,
      'bad-name-adapters.ts',
    );
    const result = await runBin(['run', 'bad name', 'SELECT 1'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Invalid adapter name "bad name"/);
    assert.match(result.stderr, /TEXT2SQL_ADAPTERS=/);
  });

  it('loads adapter modules from a relative TEXT2SQL_ADAPTERS path', async () => {
    const cwd = makeTmpDir();
    writeAdaptersModule(
      cwd,
      `export default {
        mem: {
          format: (sql) => sql,
          validate: async () => null,
          execute: async () => [{ ok: true }],
        },
      };`,
      'relative-adapters.ts',
    );

    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath: './relative-adapters.ts',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /\ncolumns: ok\nrows: 1\n$/);
  });

  it('loads adapter modules from non-path import specifiers', async () => {
    const cwd = makeTmpDir();
    const source = encodeURIComponent(`export default {
      mem: {
        format: (sql) => sql,
        validate: async () => null,
        execute: async () => [{ n: 1 }],
      },
    };`);
    const result = await runBin(['run', 'mem', 'SELECT 1'], {
      cwd,
      adaptersPath: `data:text/javascript,${source}`,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /\ncolumns: n\nrows: 1\n$/);
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

  it('errors: index requires TEXT2SQL_ADAPTERS env var', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['index'], {
      cwd,
      adaptersPath: null,
    });
    assert.equal(result.exitCode, 2);
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
    const adaptersPath = writeAdaptersModule(
      cwd,
      'export default {};',
      'empty-adapters.ts',
    );

    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /default export is an empty object/);
  });

  it('errors: adapter module without a default export', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      'export const adapters = {};',
      'missing-default-adapters.ts',
    );

    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /default export must be a Record<string, Adapter> \(got undefined\)/,
    );
  });

  it('errors: null adapter module default export', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      'export default null;',
      'null-adapters.ts',
    );

    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /default export must be a Record<string, Adapter> \(got null\)/,
    );
  });

  it('errors: array adapter module default export', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      'export default [];',
      'array-adapters.ts',
    );

    const result = await runBin(['run', 'mem', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /default export must be a Record<string, Adapter> \(got array\)/,
    );
  });

  it('errors: malformed adapter value', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      'export default { bad: { format() {} } };',
      'bad-adapters.ts',
    );

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

  it('errors: invalid adapter name (leading digit) rejected at load time', async () => {
    const cwd = makeTmpDir();
    const adaptersPath = writeAdaptersModule(
      cwd,
      `export default {
  '1bad': {
    format(sql) { return sql; },
    async validate() {},
    async execute() { return []; },
  },
};`,
      'bad-name-adapters.ts',
    );

    const result = await runBin(['run', '1bad', 'SELECT 1 as n'], {
      cwd,
      adaptersPath,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Invalid adapter name "1bad"/);
    assert.match(result.stderr, /\[A-Za-z_\]\[A-Za-z0-9_\]/);
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

  it('errors: missing db arg', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /missing required args for command `run <db> <\.\.\.sql>`/,
    );
  });

  it('errors: missing sql arg', async () => {
    const cwd = makeTmpDir();
    const result = await runBin(['run', 'mem'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.match(
      result.stderr,
      /missing required args for command `run <db> <\.\.\.sql>`/,
    );
  });
});
