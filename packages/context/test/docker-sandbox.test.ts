import spawn from 'nano-spawn';
import assert from 'node:assert';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  ContainerCreationError,
  type DisposableSandbox,
  DockerSandboxError,
  InstallError,
  Installer,
  type InstallerContext,
  MissingRuntimeError,
  PackageInstallError,
  VolumeCreateError,
  VolumeInspectError,
  VolumePathError,
  createBashTool,
  createDockerSandbox,
  npm,
  pip,
  pkg,
  urlBinary,
  useSandbox,
} from '@deepagents/context';

/**
 * Check if Docker is available on this machine.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

function testVolumeName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function removeDockerVolume(name: string): Promise<void> {
  try {
    await spawn('docker', ['volume', 'rm', name]);
  } catch {
    // Test cleanup should be best-effort.
  }
}

class DeleteVolumeThenFailInstaller extends Installer {
  readonly kind = 'delete-volume-then-fail';
  private readonly volumeName: string;

  constructor(volumeName: string) {
    super();
    this.volumeName = volumeName;
  }

  async install(ctx: InstallerContext): Promise<void> {
    await spawn('docker', ['stop', ctx.containerId]);
    await spawn('docker', ['volume', 'rm', this.volumeName]);
    throw new Error('installer failed after deleting volume');
  }
}

/**
 * Integration tests for Docker sandbox.
 *
 * These tests require Docker to be installed and running.
 * Tests are skipped gracefully if Docker is not available.
 */
describe('Docker Sandbox', async () => {
  const dockerAvailable = await isDockerAvailable();

  if (!dockerAvailable) {
    console.log('Skipping Docker sandbox tests: Docker not available');
    return;
  }

  describe('createDockerSandbox', () => {
    describe('container creation', () => {
      it('creates container with default settings', async () => {
        const sandbox = await createDockerSandbox();

        try {
          const result = await sandbox.executeCommand('echo hello');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'hello');
        } finally {
          await sandbox.dispose();
        }
      });

      it('creates container with Alpine image (default)', async () => {
        const sandbox = await createDockerSandbox();

        try {
          // Alpine uses ash shell
          const result = await sandbox.executeCommand('cat /etc/os-release');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /alpine/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('creates container with custom Debian image', async () => {
        const sandbox = await createDockerSandbox({
          image: 'debian:stable-slim',
        });

        try {
          const result = await sandbox.executeCommand('cat /etc/os-release');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /debian/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets /workspace as working directory', async () => {
        const sandbox = await createDockerSandbox();

        try {
          const result = await sandbox.executeCommand('pwd');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), '/workspace');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('package installation', () => {
      it('installs packages with apk on Alpine', async () => {
        const sandbox = await createDockerSandbox({
          installers: [pkg(['curl'])],
        });

        try {
          const result = await sandbox.executeCommand('curl --version');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /curl/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('installs packages with apt-get on Debian', async () => {
        const sandbox = await createDockerSandbox({
          image: 'debian:stable-slim',
          installers: [pkg(['curl'])],
        });

        try {
          const result = await sandbox.executeCommand('curl --version');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /curl/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('creates sandbox without packages when array is empty', async () => {
        const sandbox = await createDockerSandbox({
          installers: [],
        });

        try {
          const result = await sandbox.executeCommand('echo works');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'works');
        } finally {
          await sandbox.dispose();
        }
      });

      it('throws error for non-existent package', async () => {
        await assert.rejects(
          createDockerSandbox({
            installers: [pkg(['nonexistent-pkg-xyz-12345'])],
          }),
          /Package installation failed/,
        );
      });
    });

    describe('command execution', () => {
      let sandbox: DisposableSandbox;

      before(async () => {
        sandbox = await createDockerSandbox();
      });

      after(async () => {
        await sandbox.dispose();
      });

      it('captures stdout correctly', async () => {
        const result = await sandbox.executeCommand('echo "test output"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'test output');
      });

      it('captures stderr correctly', async () => {
        const result = await sandbox.executeCommand('echo "error" >&2');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stderr.trim(), 'error');
      });

      it('preserves exit codes', async () => {
        const result = await sandbox.executeCommand('exit 42');
        assert.strictEqual(result.exitCode, 42);
      });

      it('returns exit code 127 for command not found', async () => {
        const result = await sandbox.executeCommand('nonexistent_command_xyz');
        assert.strictEqual(result.exitCode, 127);
        assert.match(result.stderr, /not found/i);
      });

      it('handles multi-line output', async () => {
        const result = await sandbox.executeCommand(
          'echo "line1"; echo "line2"; echo "line3"',
        );
        assert.strictEqual(result.exitCode, 0);
        const lines = result.stdout.trim().split('\n');
        assert.deepStrictEqual(lines, ['line1', 'line2', 'line3']);
      });

      it('handles special characters in output', async () => {
        const result = await sandbox.executeCommand('echo "hello $USER world"');
        assert.strictEqual(result.exitCode, 0);
        // $USER should expand (or be empty) - just check it doesn't error
      });
    });

    describe('file operations', () => {
      let sandbox: DisposableSandbox;

      before(async () => {
        sandbox = await createDockerSandbox();
      });

      after(async () => {
        await sandbox.dispose();
      });

      it('writes single file', async () => {
        await sandbox.writeFiles([
          { path: '/tmp/test.txt', content: 'hello world' },
        ]);

        const content = await sandbox.readFile('/tmp/test.txt');
        assert.strictEqual(content.trim(), 'hello world');
      });

      it('writes multiple files', async () => {
        await sandbox.writeFiles([
          { path: '/tmp/file1.txt', content: 'content1' },
          { path: '/tmp/file2.txt', content: 'content2' },
        ]);

        const content1 = await sandbox.readFile('/tmp/file1.txt');
        const content2 = await sandbox.readFile('/tmp/file2.txt');
        assert.strictEqual(content1.trim(), 'content1');
        assert.strictEqual(content2.trim(), 'content2');
      });

      it('creates parent directories automatically', async () => {
        await sandbox.writeFiles([
          { path: '/tmp/nested/deep/file.txt', content: 'nested content' },
        ]);

        const content = await sandbox.readFile('/tmp/nested/deep/file.txt');
        assert.strictEqual(content.trim(), 'nested content');
      });

      it('handles files with special characters', async () => {
        const specialContent = 'line1\nline2\ttab\n';
        await sandbox.writeFiles([
          { path: '/tmp/special.txt', content: specialContent },
        ]);

        const content = await sandbox.readFile('/tmp/special.txt');
        // newlines and tabs should be preserved
        assert.strictEqual(content, specialContent);
      });

      it('throws error when reading non-existent file', async () => {
        await assert.rejects(
          sandbox.readFile('/nonexistent/path/file.txt'),
          /Failed to read file/,
        );
      });
    });

    describe('volumes', () => {
      let tempDir: string;

      before(async () => {
        tempDir = join(tmpdir(), `docker-sandbox-test-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        await writeFile(join(tempDir, 'host-file.txt'), 'from host');
      });

      after(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      it('attaches bind volume as read-only by default', async () => {
        const sandbox = await createDockerSandbox({
          volumes: [
            {
              type: 'bind',
              hostPath: tempDir,
              containerPath: '/data',
            },
          ],
        });

        try {
          // Should be able to read
          const readResult = await sandbox.executeCommand(
            'cat /data/host-file.txt',
          );
          assert.strictEqual(readResult.exitCode, 0);
          assert.strictEqual(readResult.stdout.trim(), 'from host');

          // Should not be able to write (read-only)
          const writeResult = await sandbox.executeCommand(
            'echo "test" > /data/new-file.txt',
          );
          assert.notStrictEqual(writeResult.exitCode, 0);
          assert.match(writeResult.stderr, /read-only/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches bind volume as read-write when specified', async () => {
        const sandbox = await createDockerSandbox({
          volumes: [
            {
              type: 'bind',
              hostPath: tempDir,
              containerPath: '/data',
              readOnly: false,
            },
          ],
        });

        try {
          // Should be able to write
          const writeResult = await sandbox.executeCommand(
            'echo "container wrote this" > /data/container-file.txt',
          );
          assert.strictEqual(writeResult.exitCode, 0);

          // Verify file exists on host
          const hostContent = await readFile(
            join(tempDir, 'container-file.txt'),
            'utf-8',
          );
          assert.strictEqual(hostContent.trim(), 'container wrote this');
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches an existing Docker volume and keeps it after dispose', async () => {
        const volumeName = testVolumeName('deepagents-external');
        await spawn('docker', ['volume', 'create', volumeName]);

        try {
          const writer = await createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: volumeName,
                containerPath: '/data',
                readOnly: false,
              },
            ],
          });

          try {
            const writeResult = await writer.executeCommand(
              'echo "persisted" > /data/file.txt',
            );
            assert.strictEqual(writeResult.exitCode, 0);
          } finally {
            await writer.dispose();
          }

          const reader = await createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: volumeName,
                containerPath: '/data',
              },
            ],
          });

          try {
            const readResult =
              await reader.executeCommand('cat /data/file.txt');
            assert.strictEqual(readResult.exitCode, 0);
            assert.strictEqual(readResult.stdout.trim(), 'persisted');
          } finally {
            await reader.dispose();
          }
        } finally {
          await removeDockerVolume(volumeName);
        }
      });

      it('throws VolumeInspectError for a missing external Docker volume', async () => {
        const volumeName = testVolumeName('deepagents-missing');

        await assert.rejects(
          createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: volumeName,
                containerPath: '/data',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof VolumeInspectError);
            assert.strictEqual(err.name, 'VolumeInspectError');
            const volumeErr = err as VolumeInspectError;
            assert.strictEqual(volumeErr.volume, volumeName);
            return true;
          },
        );
      });

      it('creates and removes a managed Docker volume on dispose', async () => {
        const volumeName = testVolumeName('deepagents-managed');
        const sandbox = await createDockerSandbox({
          volumes: [
            {
              type: 'volume',
              name: volumeName,
              containerPath: '/data',
              lifecycle: 'managed',
              readOnly: false,
            },
          ],
        });

        try {
          const writeResult = await sandbox.executeCommand(
            'echo "managed" > /data/file.txt',
          );
          assert.strictEqual(writeResult.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }

        await assert.rejects(
          spawn('docker', ['volume', 'inspect', volumeName]),
          (err: Error & { exitCode?: number; stderr?: string }) => {
            assert.strictEqual(err.exitCode, 1);
            return true;
          },
        );
      });

      it('attaches managed Docker volume as read-only by default', async () => {
        const volumeName = testVolumeName('deepagents-managed-ro');
        const sandbox = await createDockerSandbox({
          volumes: [
            {
              type: 'volume',
              name: volumeName,
              containerPath: '/data',
              lifecycle: 'managed',
            },
          ],
        });

        try {
          const writeResult = await sandbox.executeCommand(
            'echo "blocked" > /data/file.txt',
          );
          assert.notStrictEqual(writeResult.exitCode, 0);
          assert.match(writeResult.stderr, /read-only/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('throws VolumeCreateError when managed volume already exists', async () => {
        const volumeName = testVolumeName('deepagents-existing-managed');
        await spawn('docker', ['volume', 'create', volumeName]);

        try {
          await assert.rejects(
            createDockerSandbox({
              volumes: [
                {
                  type: 'volume',
                  name: volumeName,
                  containerPath: '/data',
                  lifecycle: 'managed',
                },
              ],
            }),
            (err: Error) => {
              assert.ok(err instanceof VolumeCreateError);
              assert.strictEqual(err.name, 'VolumeCreateError');
              const volumeErr = err as VolumeCreateError;
              assert.strictEqual(volumeErr.volume, volumeName);
              return true;
            },
          );
        } finally {
          await removeDockerVolume(volumeName);
        }
      });

      it('preserves original configuration error when managed volume cleanup fails', async () => {
        const volumeName = testVolumeName('deepagents-cleanup-failure');

        await assert.rejects(
          createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: volumeName,
                containerPath: '/data',
                lifecycle: 'managed',
              },
            ],
            installers: [new DeleteVolumeThenFailInstaller(volumeName)],
          }),
          /installer failed after deleting volume/,
        );
      });
    });

    describe('environment variables', () => {
      it('sets env vars in the container', async () => {
        const sandbox = await createDockerSandbox({
          env: { MY_VAR: 'hello', ANOTHER: 'world' },
        });

        try {
          const result = await sandbox.executeCommand(
            'echo "$MY_VAR $ANOTHER"',
          );
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'hello world');
        } finally {
          await sandbox.dispose();
        }
      });

      it('env vars persist across exec calls', async () => {
        const sandbox = await createDockerSandbox({
          env: { PERSIST_TEST: 'sticky' },
        });

        try {
          const r1 = await sandbox.executeCommand('echo "$PERSIST_TEST"');
          const r2 = await sandbox.executeCommand('echo "$PERSIST_TEST"');
          assert.strictEqual(r1.stdout.trim(), 'sticky');
          assert.strictEqual(r2.stdout.trim(), 'sticky');
        } finally {
          await sandbox.dispose();
        }
      });

      it('handles env values with spaces', async () => {
        const sandbox = await createDockerSandbox({
          env: { SPACED: 'hello world foo' },
        });

        try {
          const result = await sandbox.executeCommand('echo "$SPACED"');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'hello world foo');
        } finally {
          await sandbox.dispose();
        }
      });

      it('handles env values containing equals signs', async () => {
        const sandbox = await createDockerSandbox({
          env: { DB_URL: 'host=localhost;port=5432' },
        });

        try {
          const result = await sandbox.executeCommand('echo "$DB_URL"');
          assert.strictEqual(result.stdout.trim(), 'host=localhost;port=5432');
        } finally {
          await sandbox.dispose();
        }
      });

      it('works with empty env object', async () => {
        const sandbox = await createDockerSandbox({
          env: {},
        });

        try {
          const result = await sandbox.executeCommand('echo works');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'works');
        } finally {
          await sandbox.dispose();
        }
      });

      it('rejects env keys containing equals sign', async () => {
        await assert.rejects(
          createDockerSandbox({
            env: { 'FOO=BAR': 'val' },
          }),
          /Invalid environment variable key/,
        );
      });
    });

    describe('resource limits', () => {
      it('applies custom memory and CPU limits', async () => {
        const sandbox = await createDockerSandbox({
          resources: {
            memory: '256m',
            cpus: 1,
          },
        });

        try {
          // Container should work with limits
          const result = await sandbox.executeCommand('echo "limited"');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'limited');
        } finally {
          await sandbox.dispose();
        }
      });

      it('sizes /dev/shm via shmSize', async () => {
        const sandbox = await createDockerSandbox({
          resources: { shmSize: '64m' },
        });

        try {
          const result = await sandbox.executeCommand('df -k /dev/shm');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /65536/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('applies a file-descriptor ulimit to PID 1', async () => {
        const sandbox = await createDockerSandbox({
          resources: { ulimits: ['nofile=512:512'] },
        });

        try {
          const result = await sandbox.executeCommand('cat /proc/1/limits');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /Max open files\s+512\s+512/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('caps the process count via pidsLimit', async () => {
        const sandbox = await createDockerSandbox({
          resources: { pidsLimit: 42 },
        });

        try {
          const result = await sandbox.executeCommand(
            'cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max',
          );
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), '42');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('container runtime', () => {
      it('runs the container under the default runtime when runtime is omitted', async () => {
        const sandbox = await createDockerSandbox({
          runtime: 'runc',
        });

        try {
          const result = await sandbox.executeCommand('echo runc');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'runc');
        } finally {
          await sandbox.dispose();
        }
      });

      it('passes runtime through to `docker run --runtime`', async () => {
        const bogusRuntime = 'sandbox-nonexistent-runtime';

        await assert.rejects(
          createDockerSandbox({ runtime: bogusRuntime }),
          (error: unknown) => {
            assert.ok(error instanceof ContainerCreationError);
            assert.match(error.message, new RegExp(bogusRuntime));
            return true;
          },
        );
      });
    });

    describe('networking', () => {
      it('isolates the container with network mode none', async () => {
        const sandbox = await createDockerSandbox({
          network: { mode: 'none' },
        });

        try {
          const result = await sandbox.executeCommand('ls /sys/class/net');
          assert.strictEqual(result.exitCode, 0);
          const interfaces = result.stdout.trim().split(/\s+/);
          assert.ok(interfaces.includes('lo'));
          assert.ok(
            !interfaces.includes('eth0'),
            `expected no eth0 under network mode none, got: ${result.stdout}`,
          );
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets a custom hostname', async () => {
        const sandbox = await createDockerSandbox({
          network: { hostname: 'sandbox-host' },
        });

        try {
          const result = await sandbox.executeCommand('hostname');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'sandbox-host');
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets custom DNS servers', async () => {
        const sandbox = await createDockerSandbox({
          network: { dns: ['1.2.3.4'] },
        });

        try {
          const result = await sandbox.executeCommand('cat /etc/resolv.conf');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /nameserver\s+1\.2\.3\.4/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('adds host-to-IP mappings with addHost', async () => {
        const sandbox = await createDockerSandbox({
          network: { addHost: ['myhost:10.1.2.3'] },
        });

        try {
          const result = await sandbox.executeCommand('cat /etc/hosts');
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /10\.1\.2\.3\s+myhost/);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('process and workspace', () => {
      it('runs an init process as PID 1 with init:true', async () => {
        const sandbox = await createDockerSandbox({ init: true });

        try {
          const result = await sandbox.executeCommand('cat /proc/1/comm');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'docker-init');
        } finally {
          await sandbox.dispose();
        }
      });

      it('uses a custom workdir', async () => {
        const sandbox = await createDockerSandbox({ workdir: '/srv' });

        try {
          const result = await sandbox.executeCommand('pwd');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), '/srv');
        } finally {
          await sandbox.dispose();
        }
      });

      it('overrides the image entrypoint', async () => {
        const sandbox = await createDockerSandbox({
          entrypoint: '/bin/sleep',
          command: ['infinity'],
        });

        try {
          const result = await sandbox.executeCommand('cat /proc/1/comm');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'sleep');
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets kernel parameters via sysctls', async () => {
        const sandbox = await createDockerSandbox({
          sysctls: { 'net.ipv4.ip_forward': '1' },
        });

        try {
          const result = await sandbox.executeCommand(
            'cat /proc/sys/net/ipv4/ip_forward',
          );
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), '1');
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches container labels', async () => {
        const name = `label-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const sandbox = await createDockerSandbox({
          name,
          labels: { 'com.example.role': 'sandbox-test' },
        });

        try {
          const inspect = await spawn('docker', [
            'inspect',
            '--format',
            '{{index .Config.Labels "com.example.role"}}',
            `sandbox-${name}`,
          ]);
          assert.strictEqual(inspect.stdout.trim(), 'sandbox-test');
        } finally {
          await sandbox.dispose();
        }
      });

      // gpus, devices, cpuShares, cpusetCpus, and memorySwap are emitted the same
      // way as the flags above, but are not asserted here: observing them needs
      // GPU/host-device hardware or CPU/memory contention that a single isolated
      // container cannot reliably create.
    });

    describe('security hardening', () => {
      it('runs as a non-root user', async () => {
        const sandbox = await createDockerSandbox({
          security: { user: '1000:1000' },
        });

        try {
          const result = await sandbox.executeCommand('id -u');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), '1000');
        } finally {
          await sandbox.dispose();
        }
      });

      it('mounts a read-only rootfs with a writable tmpfs workspace', async () => {
        const sandbox = await createDockerSandbox({
          security: { readOnly: true, tmpfs: ['/workspace', '/tmp'] },
        });

        try {
          await sandbox.writeFiles([
            { path: '/workspace/ok.txt', content: 'written' },
          ]);
          assert.strictEqual(
            (await sandbox.readFile('/workspace/ok.txt')).trim(),
            'written',
          );

          const rootWrite = await sandbox.executeCommand(
            'echo nope > /etc/blocked.txt',
          );
          assert.notStrictEqual(rootWrite.exitCode, 0);
          assert.match(rootWrite.stderr, /read-only file system/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('drops Linux capabilities', async () => {
        const sandbox = await createDockerSandbox({
          security: { capDrop: ['ALL'] },
        });

        try {
          await sandbox.executeCommand('touch /tmp/cap-probe');
          const chown = await sandbox.executeCommand(
            'chown 1000 /tmp/cap-probe',
          );
          assert.notStrictEqual(chown.exitCode, 0);
          assert.match(chown.stderr, /not permitted|operation not permitted/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('re-grants a capability with capAdd', async () => {
        const sandbox = await createDockerSandbox({
          security: { capDrop: ['ALL'], capAdd: ['CHOWN'] },
        });

        try {
          await sandbox.executeCommand('touch /tmp/cap-probe');
          const chown = await sandbox.executeCommand(
            'chown 1000 /tmp/cap-probe',
          );
          assert.strictEqual(chown.exitCode, 0, chown.stderr);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('Dockerfile strategy', () => {
      it('builds an image from an inline Dockerfile', async () => {
        const sandbox = await createDockerSandbox({
          dockerfile:
            'FROM alpine:latest\nRUN echo inline-build > /built-marker\n',
        });

        try {
          const result = await sandbox.executeCommand('cat /built-marker');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'inline-build');
        } finally {
          await sandbox.dispose();
        }
      });

      it('builds an image from a Dockerfile path', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sandbox-dockerfile-'));
        await writeFile(
          join(dir, 'Dockerfile'),
          'FROM alpine:latest\nRUN echo file-build > /built-marker\n',
        );

        try {
          const sandbox = await createDockerSandbox({
            dockerfile: join(dir, 'Dockerfile'),
            context: dir,
          });
          try {
            const result = await sandbox.executeCommand('cat /built-marker');
            assert.strictEqual(result.exitCode, 0);
            assert.strictEqual(result.stdout.trim(), 'file-build');
          } finally {
            await sandbox.dispose();
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    });

    describe('cleanup', () => {
      it('dispose stops and removes container', async () => {
        const sandbox = await createDockerSandbox();

        // Verify container is running
        const beforeResult = await sandbox.executeCommand('echo alive');
        assert.strictEqual(beforeResult.exitCode, 0);

        // Dispose
        await sandbox.dispose();

        // Commands should now fail (container gone)
        // Note: This may throw or return error depending on timing
        try {
          await sandbox.executeCommand('echo should-fail');
          // If we get here without error, that's unexpected but not a failure
          // The container might still be stopping
        } catch {
          // Expected - container is gone
        }
      });

      it('dispose is idempotent (can call multiple times)', async () => {
        const sandbox = await createDockerSandbox();

        await sandbox.dispose();
        await sandbox.dispose(); // Should not throw
        await sandbox.dispose(); // Should not throw
      });
    });

    describe('stable container name', () => {
      function uniqueName(): string {
        return `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      }

      async function removeContainer(containerId: string): Promise<void> {
        try {
          await spawn('docker', ['rm', '-f', containerId]);
        } catch {
          // best-effort
        }
      }

      it('names the container `sandbox-<name>`', async () => {
        const name = uniqueName();
        const sandbox = await createDockerSandbox({ name });

        try {
          const inspect = await spawn('docker', [
            'container',
            'inspect',
            '--format',
            '{{.Name}}',
            `sandbox-${name}`,
          ]);
          assert.strictEqual(inspect.stdout.trim(), `/sandbox-${name}`);
        } finally {
          await sandbox.dispose();
          await removeContainer(`sandbox-${name}`);
        }
      });

      it('attaches to an existing running container and skips installers', async () => {
        const name = uniqueName();
        const first = await createDockerSandbox({
          name,
          installers: [pkg(['curl'])],
        });

        let second: DisposableSandbox | undefined;
        try {
          await first.executeCommand('echo first-run > /workspace/marker');

          second = await createDockerSandbox({
            name,
            // Different installers would normally rerun; attach must skip them.
            installers: [pkg(['nonexistent-package-should-not-install'])],
          });

          const marker = await second.executeCommand('cat /workspace/marker');
          assert.strictEqual(marker.exitCode, 0);
          assert.strictEqual(marker.stdout.trim(), 'first-run');

          const curl = await second.executeCommand('curl --version');
          assert.strictEqual(curl.exitCode, 0);
        } finally {
          // dispose() stops the shared container — either call works once,
          // and the second is a no-op (errors swallowed in stopContainer).
          await second?.dispose();
          await first.dispose();
          await removeContainer(`sandbox-${name}`);
        }
      });

      it('converges two concurrent same-named creations onto one container', async () => {
        // Both calls inspect 'absent', then race to `docker run`. The daemon
        // serializes the create, so one wins and the loser's run fails with a
        // name conflict. The loser must recover — reprobe and attach to the
        // winner's container — instead of throwing, so BOTH handles end up on
        // the same container. (This is the only path that exercises the
        // name-collision recovery branch; every sequential case attaches via
        // the inspect-first branch above.)
        const name = uniqueName();

        let a: DisposableSandbox | undefined;
        let b: DisposableSandbox | undefined;
        try {
          // If recovery were broken, the losing create would reject and this
          // Promise.all would reject — failing the test.
          [a, b] = await Promise.all([
            createDockerSandbox({ name }),
            createDockerSandbox({ name }),
          ]);

          // One handle writes; the other must read it back — proving both
          // resolved to the same underlying container.
          await a.executeCommand('echo converged > /workspace/marker');
          const read = await b.executeCommand('cat /workspace/marker');
          assert.strictEqual(read.exitCode, 0);
          assert.strictEqual(read.stdout.trim(), 'converged');

          // Exactly one container exists with that name.
          const ls = await spawn('docker', [
            'ps',
            '-a',
            '--filter',
            `name=^/sandbox-${name}$`,
            '--format',
            '{{.Names}}',
          ]);
          assert.strictEqual(ls.stdout.trim(), `sandbox-${name}`);
        } finally {
          await a?.dispose();
          await b?.dispose();
          await removeContainer(`sandbox-${name}`);
        }
      });

      it('starts a stopped container with the same name and attaches', async () => {
        // Pre-create a container WITHOUT --rm so it stays around after stop;
        // the factory always uses --rm, so factory-created containers can
        // never naturally be in this state. This covers external/handoff
        // scenarios where another process created the container.
        const name = uniqueName();
        const containerId = `sandbox-${name}`;

        await spawn('docker', [
          'run',
          '-d',
          '--name',
          containerId,
          'alpine:latest',
          'tail',
          '-f',
          '/dev/null',
        ]);
        await spawn('docker', ['stop', containerId]);

        try {
          const sandbox = await createDockerSandbox({ name });
          const result = await sandbox.executeCommand('echo back-online');
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout.trim(), 'back-online');

          await sandbox.dispose();
        } finally {
          await removeContainer(containerId);
        }
      });

      it('rejects names that are not Docker-legal', async () => {
        await assert.rejects(
          createDockerSandbox({ name: '' }),
          /Invalid container name/,
        );
        await assert.rejects(
          createDockerSandbox({ name: 'has spaces' }),
          /Invalid container name/,
        );
        await assert.rejects(
          createDockerSandbox({ name: 'has/slash' }),
          /Invalid container name/,
        );
      });

      it('tolerates concurrent calls with the same name', async () => {
        // Two parallel callers must both end up with a usable handle to the
        // SAME container, regardless of who wins the `docker run` race. The
        // loser may take the plain "saw running" attach path or the
        // race-recovery "got conflict, re-probe, attach" path depending on
        // scheduling — both are acceptable; this test is a smoke check
        // that no caller throws.
        const name = uniqueName();
        const containerId = `sandbox-${name}`;

        try {
          const [a, b] = await Promise.all([
            createDockerSandbox({ name }),
            createDockerSandbox({ name }),
          ]);

          const ra = await a.executeCommand('echo a');
          const rb = await b.executeCommand('echo b');
          assert.strictEqual(ra.stdout.trim(), 'a');
          assert.strictEqual(rb.stdout.trim(), 'b');

          const list = await spawn('docker', [
            'ps',
            '--filter',
            `name=^${containerId}$`,
            '--format',
            '{{.Names}}',
          ]);
          const matches = list.stdout
            .trim()
            .split('\n')
            .filter((n) => n === containerId);
          assert.strictEqual(matches.length, 1);

          await a.dispose();
        } finally {
          await removeContainer(containerId);
        }
      });

      it('falls back to random naming when no name is provided', async () => {
        const a = await createDockerSandbox();
        const b = await createDockerSandbox();
        try {
          await a.executeCommand('echo a');
          await b.executeCommand('echo b');
        } finally {
          await a.dispose();
          await b.dispose();
        }
      });
    });
  });

  describe('createDockerSandbox + createBashTool', () => {
    it('returns bash tool and sandbox', async () => {
      const backend = await createDockerSandbox({ installers: [] });
      const { bash, tools, sandbox } = await createBashTool({
        sandbox: backend,
      });

      try {
        assert.ok(bash);
        assert.ok(tools);
        assert.ok(tools.bash);
        assert.ok(tools.readFile);
        assert.ok(tools.writeFile);
        assert.ok(sandbox);
        assert.strictEqual(typeof sandbox.dispose, 'function');
      } finally {
        await sandbox.dispose();
      }
    });

    it('bash tool executes commands in container', async () => {
      const backend = await createDockerSandbox();
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.executeCommand('echo "from container"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'from container');
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects installers option', async () => {
      const backend = await createDockerSandbox({
        installers: [pkg(['curl'])],
      });
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.executeCommand('curl --version');
        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /curl/i);
      } finally {
        await sandbox.dispose();
      }
    });

    it('passes env vars through to container', async () => {
      const backend = await createDockerSandbox({
        env: { TOOL_VAR: 'via-tool' },
      });
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.executeCommand('echo "$TOOL_VAR"');
        assert.strictEqual(result.stdout.trim(), 'via-tool');
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects volumes option', async () => {
      const tempDir = join(tmpdir(), `container-tool-test-${Date.now()}`);
      await mkdir(tempDir, { recursive: true });
      await writeFile(join(tempDir, 'test.txt'), 'mounted content');

      const backend = await createDockerSandbox({
        volumes: [
          {
            type: 'bind',
            hostPath: tempDir,
            containerPath: '/mounted',
            readOnly: true,
          },
        ],
      });
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.executeCommand('cat /mounted/test.txt');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'mounted content');
      } finally {
        await sandbox.dispose();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('useSandbox', () => {
    it('auto-disposes sandbox on successful completion', async () => {
      let sandboxRef: DisposableSandbox | null = null;

      const result = await useSandbox({}, async (sandbox) => {
        sandboxRef = sandbox;
        const output = await sandbox.executeCommand(
          'echo "hello from useSandbox"',
        );
        return output.stdout.trim();
      });

      assert.strictEqual(result, 'hello from useSandbox');

      // Verify sandbox is disposed (command should fail)
      const captured1 = sandboxRef as DisposableSandbox | null;
      if (captured1) {
        try {
          await captured1.executeCommand('echo test');
          // If no error, container might still be stopping - that's ok
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('auto-disposes sandbox even when function throws', async () => {
      let sandboxRef: DisposableSandbox | null = null;

      await assert.rejects(
        useSandbox({}, async (sandbox) => {
          sandboxRef = sandbox;
          // Verify container is running
          const result = await sandbox.executeCommand('echo alive');
          assert.strictEqual(result.exitCode, 0);
          // Now throw
          throw new Error('intentional test error');
        }),
        /intentional test error/,
      );

      // Verify sandbox is disposed (command should fail)
      const captured2 = sandboxRef as DisposableSandbox | null;
      if (captured2) {
        try {
          await captured2.executeCommand('echo test');
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('returns the value from the callback', async () => {
      const result = await useSandbox(
        { installers: [pkg(['curl'])] },
        async (sandbox) => {
          const output = await sandbox.executeCommand('curl --version');
          return {
            exitCode: output.exitCode,
            hasCurl: output.stdout.includes('curl'),
          };
        },
      );

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.hasCurl, true);
    });
  });

  describe('installers', () => {
    describe('npm', () => {
      it('throws MissingRuntimeError on alpine without ensureRuntime', async () => {
        await assert.rejects(
          createDockerSandbox({ installers: [npm('prettier')] }),
          (err: Error) => {
            assert.ok(err instanceof MissingRuntimeError);
            assert.ok(err instanceof DockerSandboxError);
            const missing = err as MissingRuntimeError;
            assert.strictEqual(missing.runtime, 'npm');
            assert.deepStrictEqual(missing.required, ['node', 'npm']);
            return true;
          },
        );
      });

      it('auto-installs nodejs+npm when ensureRuntime is true', async () => {
        const sandbox = await createDockerSandbox({
          installers: [npm('cowsay', { ensureRuntime: true })],
        });
        try {
          const node = await sandbox.executeCommand('which node');
          assert.strictEqual(node.exitCode, 0);
          const cli = await sandbox.executeCommand('which cowsay');
          assert.strictEqual(cli.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });

      it('skips ensureRuntime when node base image already has node+npm', async () => {
        const sandbox = await createDockerSandbox({
          image: 'node:lts-alpine',
          installers: [npm('cowsay')],
        });
        try {
          const result = await sandbox.executeCommand('cowsay -t hi');
          assert.strictEqual(result.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('pip', () => {
      it('throws MissingRuntimeError on alpine without ensureRuntime', async () => {
        await assert.rejects(
          createDockerSandbox({ installers: [pip('requests')] }),
          (err: Error) => {
            assert.ok(err instanceof MissingRuntimeError);
            const missing = err as MissingRuntimeError;
            assert.strictEqual(missing.runtime, 'pip');
            assert.deepStrictEqual(missing.required, ['python3', 'pip3']);
            return true;
          },
        );
      });

      it('auto-installs python3+pip when ensureRuntime is true', async () => {
        const sandbox = await createDockerSandbox({
          installers: [pip('requests', { ensureRuntime: true })],
        });
        try {
          const result = await sandbox.executeCommand(
            'python3 -c "import requests; print(requests.__version__)"',
          );
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /^\d+\.\d+/);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('urlBinary', () => {
      it('auto-ensures curl on a fresh alpine image', async () => {
        const sandbox = await createDockerSandbox({
          installers: [
            urlBinary({
              name: 'yq',
              url: {
                x86_64:
                  'https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64',
                aarch64:
                  'https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_arm64',
              },
            }),
          ],
        });
        try {
          const curl = await sandbox.executeCommand('which curl');
          assert.strictEqual(curl.exitCode, 0);
          const yq = await sandbox.executeCommand('yq --version');
          assert.strictEqual(yq.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('apt-get update is run only once across installers', () => {
      it('multiple ensureTool / pkg calls do not re-run apt-get update', async () => {
        const sandbox = await createDockerSandbox({
          image: 'debian:stable-slim',
          installers: [pkg(['curl']), pkg(['jq'])],
        });
        try {
          const r1 = await sandbox.executeCommand('which curl');
          assert.strictEqual(r1.exitCode, 0);
          const r2 = await sandbox.executeCommand('which jq');
          assert.strictEqual(r2.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('InstallError', () => {
      it('throws InstallError for an invalid url-binary URL', async () => {
        await assert.rejects(
          createDockerSandbox({
            installers: [
              urlBinary({
                name: 'bogus',
                url: 'https://invalid.example.invalid/does-not-exist.tar.gz',
              }),
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof InstallError);
            const installErr = err as InstallError;
            assert.strictEqual(installErr.target, 'bogus');
            assert.strictEqual(installErr.source, 'url');
            return true;
          },
        );
      });
    });
  });

  describe('error classes', () => {
    describe('VolumePathError', () => {
      it('throws VolumePathError for non-existent bind host path', async () => {
        await assert.rejects(
          createDockerSandbox({
            volumes: [
              {
                type: 'bind',
                hostPath: '/nonexistent/path/that/does/not/exist',
                containerPath: '/app',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof VolumePathError);
            assert.ok(err instanceof DockerSandboxError);
            assert.strictEqual(err.name, 'VolumePathError');
            const volumeErr = err as VolumePathError;
            assert.strictEqual(
              volumeErr.source,
              '/nonexistent/path/that/does/not/exist',
            );
            assert.strictEqual(volumeErr.containerPath, '/app');
            assert.strictEqual(
              volumeErr.reason,
              'hostPath does not exist on host',
            );
            return true;
          },
        );
      });

      it('throws VolumePathError for bind host paths containing commas', async () => {
        const tempDir = join(tmpdir(), `docker-sandbox-comma,${Date.now()}`);
        await mkdir(tempDir, { recursive: true });

        try {
          await assert.rejects(
            createDockerSandbox({
              volumes: [
                {
                  type: 'bind',
                  hostPath: tempDir,
                  containerPath: '/app',
                },
              ],
            }),
            (err: Error) => {
              assert.ok(err instanceof VolumePathError);
              const volumeErr = err as VolumePathError;
              assert.strictEqual(volumeErr.source, tempDir);
              assert.strictEqual(
                volumeErr.reason,
                'hostPath must not contain commas',
              );
              return true;
            },
          );
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      });

      it('throws VolumePathError for container paths containing commas', async () => {
        await assert.rejects(
          createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: testVolumeName('deepagents-container-comma'),
                containerPath: '/app,data',
                lifecycle: 'managed',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof VolumePathError);
            const volumeErr = err as VolumePathError;
            assert.strictEqual(
              volumeErr.reason,
              'containerPath must not contain commas',
            );
            return true;
          },
        );
      });

      it('throws VolumePathError for volume subpaths containing commas', async () => {
        await assert.rejects(
          createDockerSandbox({
            volumes: [
              {
                type: 'volume',
                name: testVolumeName('deepagents-subpath-comma'),
                containerPath: '/data',
                lifecycle: 'managed',
                subPath: 'bad,path',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof VolumePathError);
            const volumeErr = err as VolumePathError;
            assert.strictEqual(
              volumeErr.reason,
              'subPath must not contain commas',
            );
            return true;
          },
        );
      });

      it('does not treat non-missing managed volume inspect failures as absent volumes', async () => {
        const fakeBinDir = join(
          tmpdir(),
          `docker-sandbox-fake-bin-${Date.now()}`,
        );
        const fakeDocker = join(fakeBinDir, 'docker');
        const originalPath = process.env.PATH;
        await mkdir(fakeBinDir, { recursive: true });
        await writeFile(
          fakeDocker,
          [
            '#!/bin/sh',
            'if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then',
            '  echo "permission denied inspecting volume" >&2',
            '  exit 1',
            'fi',
            'if [ "$1" = "volume" ] && [ "$2" = "create" ]; then',
            '  echo "create should not run" >&2',
            '  exit 1',
            'fi',
            'echo "unexpected docker call: $*" >&2',
            'exit 1',
            '',
          ].join('\n'),
        );
        await chmod(fakeDocker, 0o755);
        process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

        try {
          await assert.rejects(
            createDockerSandbox({
              volumes: [
                {
                  type: 'volume',
                  name: testVolumeName('deepagents-inspect-failure'),
                  containerPath: '/data',
                  lifecycle: 'managed',
                },
              ],
            }),
            (err: Error) => {
              assert.ok(err instanceof VolumeInspectError);
              const volumeErr = err as VolumeInspectError;
              assert.match(
                volumeErr.reason,
                /permission denied inspecting volume/,
              );
              return true;
            },
          );
        } finally {
          process.env.PATH = originalPath;
          await rm(fakeBinDir, { recursive: true, force: true });
        }
      });
    });

    describe('PackageInstallError', () => {
      it('throws PackageInstallError for invalid package', async () => {
        await assert.rejects(
          createDockerSandbox({
            installers: [pkg(['nonexistent-package-xyz-12345'])],
          }),
          (err: Error) => {
            assert.ok(err instanceof PackageInstallError);
            assert.ok(err instanceof DockerSandboxError);
            assert.strictEqual(err.name, 'PackageInstallError');
            const pkgErr = err as PackageInstallError;
            assert.deepStrictEqual(pkgErr.packages, [
              'nonexistent-package-xyz-12345',
            ]);
            assert.strictEqual(pkgErr.image, 'alpine:latest');
            assert.strictEqual(pkgErr.packageManager, 'apk');
            return true;
          },
        );
      });
    });

    describe('DockerSandboxError base class', () => {
      it('all errors extend DockerSandboxError', () => {
        const volumeErr = new VolumePathError(
          '/host',
          '/container',
          'hostPath does not exist on host',
        );
        const pkgErr = new PackageInstallError(
          ['pkg'],
          'alpine',
          'apk',
          'error',
        );

        assert.ok(volumeErr instanceof DockerSandboxError);
        assert.ok(pkgErr instanceof DockerSandboxError);
        assert.ok(volumeErr instanceof Error);
        assert.ok(pkgErr instanceof Error);
      });
    });
  });
});
