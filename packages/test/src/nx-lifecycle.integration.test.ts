import command from 'nano-spawn';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const nx = join(workspaceRoot, 'node_modules/nx/dist/bin/nx.js');
const plugin = join(workspaceRoot, 'packages/test/src/nx-plugin.ts');

async function fixture() {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'nx-database-lifecycle-'),
  );
  await symlink(
    join(workspaceRoot, 'node_modules'),
    join(directory.path, 'node_modules'),
    'dir',
  );
  await writeFile(
    join(directory.path, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await writeFile(
    join(directory.path, 'nx.json'),
    JSON.stringify({
      plugins: [plugin],
      targetDefaults: {
        test: {
          executor: 'nx:run-commands',
          options: {
            command: 'node --test --test-timeout=30000 ../worker.test.ts',
            cwd: '{projectRoot}',
          },
        },
      },
      tui: { enabled: false },
    }),
  );
  for (const name of ['a', 'b', 'plain']) {
    await mkdir(join(directory.path, name));
    await writeFile(
      join(directory.path, name, 'project.json'),
      JSON.stringify({
        name,
        tags: name === 'plain' ? [] : ['test:postgres'],
        targets: {
          test: {},
          build: {
            executor: 'nx:run-commands',
            options: { command: 'node --eval "process.exit(0)"' },
          },
        },
      }),
    );
  }
  await writeFile(
    join(directory.path, 'worker.test.ts'),
    `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    import { test } from 'node:test';
    import spawn from 'nano-spawn';
    import { withPostgresContainer } from '@deepagents/test';

    test('fresh databases on the shared server', async () => {
      if (process.env.NX_TASK_TARGET_PROJECT === 'plain') {
        await assert.rejects(withPostgresContainer(async () => assert.fail()), /No provisioned/);
        await writeFile('plain.json', JSON.stringify([]));
        return;
      }
      const observed = [];
      for (let i = 0; i < 2; i++) {
        await withPostgresContainer(async (server) => {
          await spawn('docker', ['exec', server.containerId, 'psql', '-U', server.user, '-d', server.database, '-c', 'CREATE TABLE isolated (id int)']);
          observed.push({ containerId: server.containerId, database: server.database, user: server.user });
        });
      }
      assert.notEqual(observed[0].database, observed[1].database);
      const server = observed[0];
      const { stdout } = await spawn('docker', ['exec', server.containerId, 'psql', '-U', server.user, '-tAc', "SELECT count(*) FROM pg_database WHERE datname IN ('" + observed.map(x => x.database).join("','") + "')"]);
      assert.equal(stdout.trim(), '0');
      await assert.rejects(withPostgresContainer(async () => assert.fail(), { image: 'unprovisioned-image' }), /No provisioned/);
      await writeFile(process.env.NX_TASK_TARGET_PROJECT + '.json', JSON.stringify(observed));
      if (process.env.LIFECYCLE_MODE === 'hold') await setTimeout(25000);
      if (process.env.LIFECYCLE_MODE === 'failure') assert.fail('intentional task failure');
    });
  `,
  );
  return directory;
}

function runNx(cwd: string, args: string[], mode: string, daemon: boolean) {
  const child = spawn(
    process.execPath,
    [nx, ...args, '--output-style=static'],
    {
      cwd,
      detached: true,
      env: {
        ...process.env,
        // This launches an independent Node runner, not a worker of this runner.
        NODE_TEST_CONTEXT: undefined,
        NX_DAEMON: String(daemon),
        NX_INTERACTIVE: 'false',
        LIFECYCLE_MODE: mode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit');
  return {
    child,
    exited,
    output: () => output,
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null && child.signalCode === null) {
        // Own the entire fixture process group, including its Node test workers.
        assert.ok(child.pid);
        process.kill(-child.pid, 'SIGKILL');
        await exited;
      }
    },
  };
}

test(
  'Nx skips provisioning for builds, untagged tests, and excluded projects',
  { timeout: 60_000 },
  async () => {
    await using directory = await fixture();
    for (const args of [
      ['run', 'a:build'],
      ['run-many', '-t', 'test', '--exclude=a,b'],
    ]) {
      await using run = runNx(directory.path, args, 'success', false);
      const [code] = await run.exited;
      assert.equal(code, 0, run.output());
    }
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory.path, 'plain/plain.json'), 'utf8'),
      ),
      [],
    );
  },
);

for (const mode of ['success', 'failure', 'SIGINT', 'SIGTERM']) {
  test(
    `Nx shares PostgreSQL across projects and cleans up after ${mode}`,
    { timeout: 120_000 },
    async (t) => {
      await using directory = await fixture();
      await using run = runNx(
        directory.path,
        ['run-many', '-t', 'test', '-p', 'a,b', '--parallel=2'],
        mode.startsWith('SIG') ? 'hold' : mode,
        false,
      );
      const observed: { containerId: string; database: string }[][] = [];
      await t
        .waitFor(
          async () => {
            observed.length = 0;
            for (const name of ['a', 'b']) {
              observed.push(
                JSON.parse(
                  await readFile(
                    join(directory.path, name, `${name}.json`),
                    'utf8',
                  ),
                ),
              );
            }
          },
          { interval: 100, timeout: 90_000 },
        )
        .catch((error) => {
          throw new Error(run.output(), { cause: error });
        });
      const ids = new Set(observed.flat().map((value) => value.containerId));
      assert.equal(ids.size, 1);
      assert.equal(
        new Set(observed.flat().map((value) => value.database)).size,
        4,
      );
      if (mode === 'SIGINT' || mode === 'SIGTERM') run.child.kill(mode);
      const [code] = await run.exited;
      assert.equal(
        code,
        mode === 'success' ? 0 : mode === 'failure' ? 1 : 130,
        run.output(),
      );
      for (const id of ids) {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `id=${id}`,
        ]);
        assert.equal(stdout.trim(), '', `server ${id} leaked after ${mode}`);
      }
    },
  );
}

test(
  'concurrent invocations on one Nx daemon own separate servers',
  { timeout: 120_000 },
  async (t) => {
    await using directory = await fixture();
    await using daemon = {
      async [Symbol.asyncDispose]() {
        await command(process.execPath, [nx, 'reset', '--onlyDaemon'], {
          cwd: directory.path,
        });
      },
    };
    await using first = runNx(directory.path, ['run', 'a:test'], 'hold', true);
    await t.waitFor(
      async () => {
        const records = JSON.parse(
          await readFile(join(directory.path, 'a/a.json'), 'utf8'),
        );
        assert.equal(records.length, 2);
      },
      { timeout: 60_000, interval: 100 },
    );
    const [{ containerId: firstId }] = JSON.parse(
      await readFile(join(directory.path, 'a/a.json'), 'utf8'),
    );
    await using second = runNx(
      directory.path,
      ['run', 'b:test'],
      'success',
      true,
    );
    const [secondCode] = await second.exited;
    assert.equal(secondCode, 0, second.output());
    const records = JSON.parse(
      await readFile(join(directory.path, 'b/b.json'), 'utf8'),
    );
    assert.notEqual(firstId, records[0].containerId);
    const { stdout } = await command('docker', [
      'ps',
      '-q',
      '--no-trunc',
      '--filter',
      `id=${firstId}`,
    ]);
    assert.equal(stdout.trim(), firstId);
    first.child.kill('SIGTERM');
    const [firstCode] = await first.exited;
    assert.equal(firstCode, 130, first.output());
    for (const id of [firstId, records[0].containerId]) {
      const { stdout } = await command('docker', [
        'ps',
        '-aq',
        '--filter',
        `id=${id}`,
      ]);
      assert.equal(stdout.trim(), '');
    }
  },
);
