import command from 'nano-spawn';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Docker, timebox } from '@deepagents/test';

test(
  'Docker identity preserves configuration, ownership, and unfinished creation',
  {
    timeout: 120_000,
  },
  async (t) => {
    const docker = new Docker();
    const scope = randomUUID();
    const labels = {
      'dev.deepagents.test.verification': scope,
      purpose: 'identity',
    };
    const options = {
      image: 'postgres:18-alpine',
      internalPort: 5432,
      env: { POSTGRES_PASSWORD: 'testpassword', POSTGRES_DB: 'postgres' },
      labels,
      tmpfs: ['/var/lib/postgresql:rw,size=512m'],
    };
    t.after(async () => {
      const { stdout } = await command('docker', [
        'ps',
        '-aq',
        '--filter',
        `label=dev.deepagents.test.verification=${scope}`,
      ]);
      for (const id of stdout.split('\n').filter(Boolean)) {
        await command('docker', ['rm', '--force', id]);
      }
    });

    const first = await docker.reuse(options);
    const reordered = await docker.reuse({
      ...options,
      env: { POSTGRES_DB: 'postgres', POSTGRES_PASSWORD: 'testpassword' },
      labels: {
        purpose: 'identity',
        'dev.deepagents.test.verification': scope,
      },
    });
    assert.equal(reordered.containerId, first.containerId);
    const different = await docker.reuse({
      ...options,
      env: { ...options.env, POSTGRES_PASSWORD: 'another-password' },
    });
    assert.notEqual(different.containerId, first.containerId);

    await assert.rejects(
      docker.reuse({
        ...options,
        healthy: () => {
          throw new Error('readiness failed');
        },
      }),
      /readiness failed/,
    );
    const healthy = await docker.reuse({
      ...options,
      healthy: ({ exec }) =>
        timebox(
          () =>
            exec([
              'psql',
              '-h',
              '127.0.0.1',
              '-U',
              'postgres',
              '-c',
              'SELECT 1',
            ]),
          { maxRetryTime: 60_000 },
        ),
    });
    assert.equal(healthy.containerId, first.containerId);

    const name = `deepagents-owned-${scope}`;
    await using owned = await docker.start({ ...options, name });
    await assert.rejects(docker.reuse({ ...options, name }), /does not match/);
    const { stdout: ownedState } = await command('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      owned.containerId,
    ]);
    assert.equal(ownedState, 'true');

    const failedName = `deepagents-failed-${scope}`;
    await assert.rejects(
      docker.start({
        ...options,
        name: failedName,
        healthy: () => {
          throw new Error('owned startup failed');
        },
      }),
      /owned startup failed/,
    );
    // Docker stop waits for exit; --rm removal can finish after it returns.
    await t.waitFor(
      async () => {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `name=^/${failedName}$`,
        ]);
        assert.equal(stdout, '');
      },
      { timeout: 5_000 },
    );

    // Reproduce a creator dying between Docker create and start. Preserve the
    // actual identity metadata instead of duplicating the library's hash logic.
    const { stdout } = await command('docker', ['inspect', first.containerId]);
    const [inspection] = JSON.parse(stdout);
    await first.cleanup();
    await t.waitFor(
      async () => {
        const { stdout } = await command('docker', [
          'ps',
          '-aq',
          '--filter',
          `id=${first.containerId}`,
        ]);
        assert.equal(stdout, '');
      },
      { timeout: 5_000 },
    );
    const labelArgs = Object.entries(
      inspection.Config.Labels as Record<string, string>,
    ).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    await command('docker', [
      'create',
      '--rm',
      '--name',
      inspection.Name.slice(1),
      ...labelArgs,
      '-e',
      'POSTGRES_PASSWORD=testpassword',
      '-e',
      'POSTGRES_DB=postgres',
      '--tmpfs',
      '/var/lib/postgresql:rw,size=512m',
      '-P',
      options.image,
    ]);
    const recovered = await docker.reuse(options);
    assert.notEqual(recovered.containerId, first.containerId);
    const { stdout: running } = await command('docker', [
      'inspect',
      '--format',
      '{{.State.Running}}',
      recovered.containerId,
    ]);
    assert.equal(running, 'true');
  },
);
