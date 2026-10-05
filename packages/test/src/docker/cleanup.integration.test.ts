import command, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempDisposable, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { Docker } from '@deepagents/test';

for (const mode of [
  'failure',
  'cancel',
  'timeout',
  'recovery',
  'signal-error',
  'signal-race',
] as const) {
  test(
    `Nx Docker supervisor cleans an interrupted scope (${mode}) and preserves unrelated containers`,
    { timeout: 180_000 },
    async (t) => {
      const docker = new Docker();
      await using sentinel = await docker.start({
        image: 'postgres:18-alpine',
        internalPort: 5432,
        env: { POSTGRES_PASSWORD: 'sentinel' },
      });
      await using directory = await mkdtempDisposable(
        resolve('../../.nx/cleanup-test-'),
      );
      const statePath = `${directory.path}/state.json`;
      const file = `${directory.path}/worker.test.ts`;
      const disconnected = `${directory.path}/disconnected`;
      if (mode === 'recovery') {
        const { stdout: dockerPath } = await command('which', ['docker']);
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        await writeFile(
          `${directory.path}/docker`,
          `#!/bin/sh\nif [ -f ${quote(disconnected)} ]; then echo 'Cannot connect to Docker daemon (injected transport failure)' >&2; exit 1; fi\nexec ${quote(dockerPath)} "$@"\n`,
          { mode: 0o755 },
        );
      }
      await writeFile(
        file,
        `
      import { test } from 'node:test';
      import { readFile, readdir, writeFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { Docker } from '@deepagents/test';
      test('disposable resources before interruption', { timeout: ${mode === 'timeout' ? 30_000 : 90_000} }, async () => {
        const docker = new Docker();
        const container = await docker.start({ image: 'postgres:18-alpine', internalPort: 5432, env: { POSTGRES_PASSWORD: 'test' } });
        const fixture = await docker.directory();
        await fixture.writeFile('sentinel.txt', 'owned');
        const volume = 'test-cleanup-' + crypto.randomUUID();
        await docker.command(['volume', 'create', '--label', 'dev.deepagents.test.run=' + process.env.DEEPAGENTS_TEST_RUN_ID, volume]);
        const { stdout } = await docker.command(['inspect', container.containerId]);
        const anonymousVolumes = JSON.parse(stdout)[0].Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name);
        const forwards = await Promise.all((await readdir(process.env.DEEPAGENTS_TEST_RUN_DIR)).filter(name => name.startsWith('forward-')).map(async name => JSON.parse(await readFile(process.env.DEEPAGENTS_TEST_RUN_DIR + '/' + name, 'utf8')).path));
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId, path: fixture.path, volume, anonymousVolumes, forwards, run: process.env.DEEPAGENTS_TEST_RUN_ID, record: process.env.DEEPAGENTS_TEST_RUN_DIR }));
        ${mode === 'recovery' ? `await writeFile(${JSON.stringify(disconnected)}, 'offline');` : ''}
        ${mode === 'cancel' || mode === 'timeout' ? 'await setTimeout(120_000);' : "throw new Error('intentional assertion failure');"}
      });
    `,
      );
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      if (mode === 'recovery')
        env.PATH = `${directory.path}:${process.env.PATH}`;
      const child = spawn(
        process.execPath,
        [
          ...(mode === 'signal-error' || mode === 'signal-race'
            ? [
                '--import',
                `data:text/javascript,${encodeURIComponent(`
                    const kill = process.kill.bind(process);
                    let denied = false;
                    process.kill = (pid, signal) => {
                      if (pid < 0 && signal === 'SIGKILL' && (${mode === 'signal-error'} || !denied)) {
                        denied = true;
                  // Terminate the real group before replaying the observed OS
                  // error, so this regression cannot orphan its SSH process.
                  try { kill(pid, signal); } catch (error) {
                    if (error.code !== 'ESRCH') throw error;
                  }
                  throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
                }
                return kill(pid, signal);
              };
            `)}`,
              ]
            : []),
          resolve('../../tools/src/run-docker-tests.ts'),
          '--test-timeout=90000',
          '--test-force-exit',
          file,
        ],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const exited = new Promise<number | null>((res, rej) => {
        child.once('exit', res);
        child.once('error', rej);
      });
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGTERM');
        await exited;
      });
      type State = {
        id: string;
        path: string;
        volume: string;
        anonymousVolumes: string[];
        forwards: string[];
        run: string;
        record: string;
      };
      await t.waitFor(
        async () => {
          JSON.parse(await readFile(statePath, 'utf8'));
        },
        { timeout: 60_000 },
      );
      const state: State = JSON.parse(await readFile(statePath, 'utf8'));
      const worker = JSON.parse(
        await readFile(`${state.record}/run.json`, 'utf8'),
      );
      assert.ok(state.anonymousVolumes.length > 0);
      t.after(async () => {
        for (const name of state.anonymousVolumes) {
          await docker.command(['volume', 'rm', name]).catch(() => {});
        }
      });
      if (mode === 'cancel') child.kill('SIGTERM');
      assert.notEqual(await exited, 0, output);
      await t.waitFor(
        () => {
          assert.throws(() => process.kill(-worker.childPid, 0), {
            code: 'ESRCH',
          });
        },
        { timeout: 5_000 },
      );
      if (mode === 'recovery' || mode === 'signal-error') {
        assert.match(output, /retained ownership record/);
        const record = JSON.parse(
          await readFile(`${state.record}/run.json`, 'utf8'),
        );
        assert.equal(record.endpoint, (await docker.info()).endpoint);
        if (mode === 'recovery') {
          assert.equal(
            (
              await docker.command([
                'inspect',
                '--format',
                '{{.State.Running}}',
                state.id,
              ])
            ).stdout,
            'true',
          );
          await rm(disconnected);
        } else {
          assert.equal(
            (await docker.command(['ps', '-aq', '--filter', `id=${state.id}`]))
              .stdout,
            '',
            'signalling errors must not bypass resource cleanup',
          );
        }
        await command(
          process.execPath,
          [
            resolve('../../tools/src/run-docker-tests.ts'),
            '--test-timeout=60000',
            '--test-name-pattern=no-matching-tests',
            file,
          ],
          { env: { ...env, NODE_TEST_CONTEXT: undefined }, timeout: 90_000 },
        );
      }
      assert.equal(
        (await docker.command(['ps', '-aq', '--filter', `id=${state.id}`]))
          .stdout,
        '',
        output,
      );
      assert.equal(
        (
          await docker.command([
            'volume',
            'ls',
            '-q',
            '--filter',
            `name=^${state.volume}$`,
          ])
        ).stdout,
        '',
        output,
      );
      for (const name of state.anonymousVolumes) {
        assert.equal(
          (
            await docker.command([
              'volume',
              'ls',
              '-q',
              '--filter',
              `name=^${name}$`,
            ])
          ).stdout,
          '',
          `supervisor left anonymous volume ${name}: ${output}`,
        );
      }
      for (const path of state.forwards) {
        await assert.rejects(readFile(`${path}/s`), { code: 'ENOENT' });
      }
      // Docker validates the remote path. This probe never creates the source.
      await assert.rejects(
        docker.command([
          'run',
          '--rm',
          '--mount',
          `type=bind,src=${state.path},dst=/fixture`,
          'postgres:18-alpine',
          'true',
        ]),
        (error) =>
          error instanceof SubprocessError &&
          /bind source path does not exist/.test(error.stderr),
      );
      await assert.rejects(readFile(`${state.record}/run.json`), {
        code: 'ENOENT',
      });
      assert.equal(
        (
          await docker.command([
            'inspect',
            '--format',
            '{{.State.Running}}',
            sentinel.containerId,
          ])
        ).stdout,
        'true',
      );
    },
  );
}
