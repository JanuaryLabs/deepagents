import spawn from 'nano-spawn';
import assert from 'node:assert';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type DockerSandboxOptions,
  type DockerSandboxVolume,
  InstallError,
  type Installer,
  bin,
  createDockerSandbox,
} from '@deepagents/context';

async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

describe('bin installer', async () => {
  const dockerAvailable = await isDockerAvailable();

  if (!dockerAvailable) {
    console.log('Skipping bin installer tests: Docker not available');
    return;
  }

  let tempDir: string;
  const HELLO_BINARY = '/mnt/bin/hello.js';

  const tempMount: DockerSandboxVolume = {
    type: 'bind',
    hostPath: '',
    containerPath: '/mnt',
    readOnly: true,
  };

  async function withSandbox(
    installers: Installer[],
    extra: Partial<DockerSandboxOptions>,
    body: (
      sandbox: Awaited<ReturnType<typeof createDockerSandbox>>,
    ) => Promise<void>,
  ): Promise<void> {
    const sandbox = await createDockerSandbox({
      image: 'node:lts-alpine',
      installers,
      ...extra,
    });
    try {
      await body(sandbox);
    } finally {
      await sandbox.dispose();
    }
  }

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bin-installer-'));
    await mkdir(join(tempDir, 'bin'), { recursive: true });
    await writeFile(
      join(tempDir, 'bin', 'hello.js'),
      `#!/usr/bin/env node\nconsole.log('linked');\n`,
      { mode: 0o755 },
    );
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('symlinks a bind-mounted binary onto PATH using the basename', async () => {
    await withSandbox(
      [bin(HELLO_BINARY)],
      { volumes: [{ ...tempMount, hostPath: tempDir }] },
      async (sandbox) => {
        const result = await sandbox.executeCommand('hello');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('follows a symlink whose target is a regular file', async () => {
    await symlink('hello.js', join(tempDir, 'bin', 'hello-shim.js'));
    await withSandbox(
      [bin('/mnt/bin/hello-shim.js')],
      { volumes: [{ ...tempMount, hostPath: tempDir }] },
      async (sandbox) => {
        const result = await sandbox.executeCommand('hello-shim');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('honors custom name and target', async () => {
    await withSandbox(
      [bin(HELLO_BINARY, { name: 'greet', target: '/opt/bin/greet' })],
      { volumes: [{ ...tempMount, hostPath: tempDir }] },
      async (sandbox) => {
        const result = await sandbox.executeCommand('/opt/bin/greet');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'linked');
      },
    );
  });

  it('reports actionable error when binary is non-executable on read-only mount', async () => {
    const nonExecDir = await mkdtemp(join(tmpdir(), 'bin-installer-noexec-'));
    await mkdir(join(nonExecDir, 'bin'), { recursive: true });
    await writeFile(
      join(nonExecDir, 'bin', 'noexec.js'),
      `#!/usr/bin/env node\nconsole.log('noexec');\n`,
      { mode: 0o644 },
    );

    try {
      await assert.rejects(
        createDockerSandbox({
          image: 'node:lts-alpine',
          installers: [bin('/mnt/bin/noexec.js')],
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
    } finally {
      await rm(nonExecDir, { recursive: true, force: true });
    }
  });

  it('throws InstallError when the binary is missing', async () => {
    await assert.rejects(
      createDockerSandbox({
        image: 'node:lts-alpine',
        installers: [bin('/var/empty/does-not-exist.js')],
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
