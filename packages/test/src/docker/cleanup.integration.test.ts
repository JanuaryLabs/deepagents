import command, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempDisposable, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { Docker } from '@deepagents/test';

for (const mode of ['failure', 'cancel', 'timeout', 'recovery'] as const) {
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
      import { writeFile } from 'node:fs/promises';
      import { setTimeout } from 'node:timers/promises';
      import { Docker } from '@deepagents/test';
      test('disposable resources before interruption', { timeout: ${mode === 'timeout' ? 30_000 : 90_000} }, async () => {
        const docker = new Docker();
        const container = await docker.start({ image: 'postgres:18-alpine', internalPort: 5432, env: { POSTGRES_PASSWORD: 'test' } });
        const fixture = await docker.directory();
        await fixture.writeFile('sentinel.txt', 'owned');
        const volume = 'test-cleanup-' + crypto.randomUUID();
        await docker.command(['volume', 'create', '--label', 'dev.deepagents.test.run=' + process.env.DEEPAGENTS_TEST_RUN_ID, volume]);
        await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ id: container.containerId, path: fixture.path, volume, run: process.env.DEEPAGENTS_TEST_RUN_ID, record: process.env.DEEPAGENTS_TEST_RUN_DIR }));
        ${mode === 'recovery' ? `await writeFile(${JSON.stringify(disconnected)}, 'offline');` : ''}
        ${mode === 'failure' || mode === 'recovery' ? "throw new Error('intentional assertion failure');" : 'await setTimeout(120_000);'}
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
      if (mode === 'cancel') child.kill('SIGTERM');
      assert.notEqual(await exited, 0, output);
      if (mode === 'recovery') {
        assert.match(output, /retained ownership record/);
        const record = JSON.parse(
          await readFile(`${state.record}/run.json`, 'utf8'),
        );
        assert.equal(record.endpoint, (await docker.info()).endpoint);
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
