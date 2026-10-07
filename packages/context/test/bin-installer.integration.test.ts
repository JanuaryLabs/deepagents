import { Docker, TestRun } from '@zukhruf/testing/docker';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type DockerSandboxVolume,
  InstallError,
  bin,
  createDockerSandbox,
  pkg,
  useSandbox,
} from '@deepagents/context';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });

type DockerDirectory = Awaited<ReturnType<Docker['directory']>>;

/** Seeds an executable `bin/hello.js` that prints `linked`. */
async function seedHelloBinary(fixture: DockerDirectory): Promise<void> {
  await fixture.mkdir('bin');
  await fixture.writeFile(
    'bin/hello.js',
    `#!/usr/bin/env node\nconsole.log('linked');\n`,
    0o755,
  );
}

describe('bin installer', () => {
  const HELLO_BINARY = '/mnt/bin/hello.js';

  const tempMount: DockerSandboxVolume = {
    type: 'bind',
    hostPath: '',
    containerPath: '/mnt',
    readOnly: true,
  };

  it('symlinks a bind-mounted binary onto PATH using the basename', async () => {
    await using fixture = await docker.directory();
    await seedHelloBinary(fixture);
    await useSandbox(
      {
        ...docker.defaults,
        image: 'node:lts-alpine',
        installers: [pkg(['bash']), bin(HELLO_BINARY)],
        volumes: [{ ...tempMount, hostPath: fixture.path }],
      },
      async (sandbox) => {
        const result = await sandbox.executeCommand('hello');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('follows a symlink whose target is a regular file', async () => {
    await using fixture = await docker.directory();
    await seedHelloBinary(fixture);
    await fixture.symlink('hello.js', 'bin/hello-shim.js');
    await useSandbox(
      {
        ...docker.defaults,
        image: 'node:lts-alpine',
        installers: [pkg(['bash']), bin('/mnt/bin/hello-shim.js')],
        volumes: [{ ...tempMount, hostPath: fixture.path }],
      },
      async (sandbox) => {
        const result = await sandbox.executeCommand('hello-shim');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('honors custom name and target', async () => {
    await using fixture = await docker.directory();
    await seedHelloBinary(fixture);
    await useSandbox(
      {
        ...docker.defaults,
        image: 'node:lts-alpine',
        installers: [
          pkg(['bash']),
          bin(HELLO_BINARY, { name: 'greet', target: '/opt/bin/greet' }),
        ],
        volumes: [{ ...tempMount, hostPath: fixture.path }],
      },
      async (sandbox) => {
        const result = await sandbox.executeCommand('/opt/bin/greet');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('reports actionable error when binary is non-executable on read-only mount', async () => {
    await using nonExec = await docker.directory();
    const nonExecDir = nonExec.path;
    await nonExec.mkdir('bin');
    await nonExec.writeFile(
      'bin/noexec.js',
      `#!/usr/bin/env node\nconsole.log('noexec');\n`,
      0o644,
    );

    await assert.rejects(
      createDockerSandbox({
        ...docker.defaults,
        image: 'node:lts-alpine',
        installers: [pkg(['bash']), bin('/mnt/bin/noexec.js')],
        volumes: [{ ...tempMount, hostPath: nonExecDir }],
      }),
      (err) => {
        assert.ok(err instanceof InstallError, 'expected InstallError');
        assert.strictEqual(err.source, 'bin');
        assert.match(
          err.reason,
          /not executable.*read-only|chmod.*on host/i,
          'reason should hint at host-side chmod; got: ' + err.reason,
        );
        return true;
      },
    );
  });

  it('throws InstallError when the binary is missing', async () => {
    await assert.rejects(
      createDockerSandbox({
        ...docker.defaults,
        image: 'node:lts-alpine',
        installers: [pkg(['bash']), bin('/var/empty/does-not-exist.js')],
      }),
      (err) => {
        assert.ok(err instanceof InstallError, 'expected InstallError');
        assert.strictEqual(err.source, 'bin');
        assert.strictEqual(err.target, 'does-not-exist');
        assert.match(err.reason, /binary not found/);
        return true;
      },
    );
  });
});
