import { DockerTestbed } from '@zukhruf/testing/docker';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { describe, it } from 'node:test';

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

import { dockerSandboxDefaults } from './helpers/docker-sandbox-defaults.ts';

const temporaryFiles = new TemporaryFiles();

const testbed = new DockerTestbed({ environment: process.env });
const defaults = dockerSandboxDefaults(testbed.defaults);

function testVolumeName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function removeDockerVolume(name: string): Promise<void> {
  const volume = await (await testbed.client()).volumes.find(name);
  await volume?.remove();
}

class DeleteVolumeThenFailInstaller extends Installer {
  readonly kind = 'delete-volume-then-fail';
  private readonly volumeName: string;

  constructor(volumeName: string) {
    super();
    this.volumeName = volumeName;
  }

  async install(ctx: InstallerContext): Promise<void> {
    const client = await testbed.client();
    const container = await client.containers.find(ctx.containerId);
    await container?.remove({ force: true });
    await removeDockerVolume(this.volumeName);
    throw new Error('installer failed after deleting volume');
  }
}

/**
 * Integration tests for Docker sandbox.
 *
 * These tests require Docker to be installed and running.
 * Tests fail explicitly if Docker is not available.
 */
describe('Docker Sandbox', () => {
  describe('createDockerSandbox', () => {
    describe('container creation', () => {
      it('creates container with default settings', async () => {
        const sandbox = await createDockerSandbox(defaults);

        try {
          const result = await sandbox.run({ command: 'echo hello' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'hello\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('creates container with Alpine image (default)', async () => {
        const sandbox = await createDockerSandbox(defaults);

        try {
          // The official Bash image is Alpine-based.
          const result = await sandbox.run({ command: 'cat /etc/os-release' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /alpine/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('fails clearly when the image does not contain Bash', async () => {
        await assert.rejects(
          createDockerSandbox({ ...defaults, image: 'alpine:latest' }),
          /Bash is required to execute sandbox commands/,
        );
      });

      it('creates container with custom Debian image', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          image: 'debian:stable-slim',
        });

        try {
          const result = await sandbox.run({ command: 'cat /etc/os-release' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /debian/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets /workspace as working directory', async () => {
        const sandbox = await createDockerSandbox(defaults);

        try {
          const result = await sandbox.run({ command: 'pwd' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, '/workspace\n');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('package installation', () => {
      it('installs packages with apk on Alpine', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          installers: [pkg(['curl'])],
        });

        try {
          const result = await sandbox.run({ command: 'curl --version' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /curl/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('installs packages with apt-get on Debian', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          image: 'debian:stable-slim',
          installers: [pkg(['curl'])],
        });

        try {
          const result = await sandbox.run({ command: 'curl --version' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /curl/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('creates sandbox without packages when array is empty', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          installers: [],
        });

        try {
          const result = await sandbox.run({ command: 'echo works' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'works\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('throws error for non-existent package', async () => {
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            installers: [pkg(['nonexistent-pkg-xyz-12345'])],
          }),
          /Package installation failed/,
        );
      });
    });

    describe('command execution', () => {
      it('captures stdout correctly', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({ command: 'echo "test output"' });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'test output\n');
      });

      it('captures stderr correctly', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({ command: 'echo "error" >&2' });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stderr, 'error\n');
      });

      it('runs each command in a login shell, whichever way it starts', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const command =
          'shopt -q login_shell && printf login || printf not-login';

        const plain = await sandbox.run({ command });
        const abortable = await sandbox.run({
          command,
          abortSignal: new AbortController().signal,
        });
        const spawned = await sandbox.spawn({ command });

        assert.strictEqual(plain.stdout, 'login');
        assert.strictEqual(abortable.stdout, 'login');
        assert.strictEqual(await text(spawned.stdout), 'login');
      });

      it('preserves exit codes', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({ command: 'exit 42' });
        assert.strictEqual(result.exitCode, 42);
      });

      it('returns exit code 127 for command not found', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({
          command: 'nonexistent_command_xyz',
        });
        assert.strictEqual(result.exitCode, 127);
        assert.match(result.stderr, /not found/i);
      });

      it('handles multi-line output', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({
          command: 'echo "line1"; echo "line2"; echo "line3"',
        });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'line1\nline2\nline3\n');
      });

      it('handles special characters in output', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const result = await sandbox.run({
          command: 'echo "hello $USER world"',
        });
        assert.strictEqual(result.exitCode, 0);
        // $USER should expand (or be empty) - just check it doesn't error
      });
    });

    describe('file operations', () => {
      it('writes single file', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        await sandbox.writeTextFile({
          path: '/tmp/test.txt',
          content: 'hello world',
        });

        const content = await sandbox.readTextFile({ path: '/tmp/test.txt' });
        assert.strictEqual(content, 'hello world');
      });

      it('writes multiple files', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        await sandbox.writeTextFile({
          path: '/tmp/file1.txt',
          content: 'content1',
        });
        await sandbox.writeTextFile({
          path: '/tmp/file2.txt',
          content: 'content2',
        });

        const content1 = await sandbox.readTextFile({ path: '/tmp/file1.txt' });
        const content2 = await sandbox.readTextFile({ path: '/tmp/file2.txt' });
        assert.strictEqual(content1, 'content1');
        assert.strictEqual(content2, 'content2');
      });

      it('creates parent directories automatically', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        await sandbox.writeTextFile({
          path: '/tmp/nested/deep/file.txt',
          content: 'nested content',
        });

        const content = await sandbox.readTextFile({
          path: '/tmp/nested/deep/file.txt',
        });
        assert.strictEqual(content, 'nested content');
      });

      it('handles files with special characters', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const specialContent = 'line1\nline2\ttab\n';
        await sandbox.writeTextFile({
          path: '/tmp/special.txt',
          content: specialContent,
        });

        const content = await sandbox.readTextFile({
          path: '/tmp/special.txt',
        });
        // newlines and tabs should be preserved
        assert.strictEqual(content, specialContent);
      });

      it('reads a file through a symbolic link', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        await sandbox.writeTextFile({
          path: '/tmp/target.txt',
          content: 'linked content',
        });
        const link = await sandbox.run({
          command:
            'mkdir -p /tmp/links && ln -s ../target.txt /tmp/links/relative.txt',
        });
        assert.strictEqual(link.exitCode, 0, link.stderr);

        const content = await sandbox.readTextFile({
          path: '/tmp/links/relative.txt',
        });

        assert.strictEqual(content, 'linked content');
        assert.deepStrictEqual(
          await sandbox.stat({ path: '/tmp/links/relative.txt' }),
          { type: 'file', size: 14 },
        );
      });

      it('writes files and directories that a numeric non-root user can modify', async () => {
        await using sandbox = await createDockerSandbox({
          ...defaults,
          security: { user: '1000:1000' },
        });
        await sandbox.writeTextFile({
          path: '/tmp/owned/deep/notes.txt',
          content: 'first',
        });

        const modify = await sandbox.run({
          command:
            'printf " second" >> /tmp/owned/deep/notes.txt && touch /tmp/owned/deep/sibling /tmp/owned/sibling',
        });

        assert.strictEqual(modify.exitCode, 0, modify.stderr);
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/tmp/owned/deep/notes.txt' }),
          'first second',
        );
      });

      it('writes through a symbolic link to a directory as a non-root user, and keeps the link', async () => {
        await using sandbox = await createDockerSandbox({
          ...defaults,
          security: { user: '1000:1000' },
        });
        await sandbox.run({
          command: 'mkdir /tmp/real && ln -s /tmp/real /tmp/link',
        });

        await sandbox.writeTextFile({
          path: '/tmp/link/direct.txt',
          content: 'direct',
        });
        await sandbox.writeTextFile({
          path: '/tmp/link/new/deep/nested.txt',
          content: 'nested',
        });
        await Promise.all(
          ['a', 'b', 'c'].map((name) =>
            sandbox.writeTextFile({
              path: `/tmp/link/shared/${name}.txt`,
              content: name,
            }),
          ),
        );

        const seen = await sandbox.run({
          command:
            'test -L /tmp/link && touch /tmp/real/new/deep/sibling && cat /tmp/real/direct.txt /tmp/real/new/deep/nested.txt /tmp/real/shared/a.txt /tmp/real/shared/b.txt /tmp/real/shared/c.txt',
        });
        assert.deepStrictEqual(
          { exitCode: seen.exitCode, stdout: seen.stdout },
          { exitCode: 0, stdout: 'directnestedabc' },
        );
      });

      it('writes files and directories that a named image user can modify', async () => {
        await using sandbox = await createDockerSandbox({
          ...defaults,
          dockerfile: [
            'FROM bash:5.3-alpine3.24',
            'RUN adduser -D sandboxer',
            'USER sandboxer',
            '',
          ].join('\n'),
        });
        await sandbox.writeTextFile({
          path: '/tmp/named/deep/notes.txt',
          content: 'first',
        });

        const modify = await sandbox.run({
          command:
            'printf " second" >> /tmp/named/deep/notes.txt && touch /tmp/named/deep/sibling /tmp/named/sibling',
        });

        assert.strictEqual(modify.exitCode, 0, modify.stderr);
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/tmp/named/deep/notes.txt' }),
          'first second',
        );
      });

      it('reads a non-existent file as null', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/nonexistent/path/file.txt' }),
          null,
        );
      });
    });

    describe('binary reads and existence checks', () => {
      it('reads raw bytes with the binary encoding', async () => {
        const sandbox = await createDockerSandbox(defaults);
        try {
          const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);
          await sandbox.writeBinaryFile({
            path: '/tmp/blob.bin',
            content: bytes,
          });

          const content = await sandbox.readBinaryFile({
            path: '/tmp/blob.bin',
          });

          assert.ok(content);
          assert.deepStrictEqual(Array.from(content), [0x89, 0x50, 0x00, 0xff]);
        } finally {
          await sandbox.dispose();
        }
      });

      it('reports whether a path exists', async () => {
        const sandbox = await createDockerSandbox(defaults);
        try {
          await sandbox.writeTextFile({
            path: '/tmp/present.txt',
            content: 'x',
          });

          assert.deepStrictEqual(
            await sandbox.stat({ path: '/tmp/present.txt' }),
            { type: 'file', size: 1 },
          );
          assert.strictEqual(
            (await sandbox.stat({ path: '/tmp' }))?.type,
            'directory',
          );
          assert.strictEqual(
            await sandbox.stat({ path: '/tmp/missing.txt' }),
            null,
          );
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('volumes', () => {
      it('attaches bind volume as read-only by default', async () => {
        await using fixture = await testbed.directory();
        await fixture.writeFile('host-file.txt', 'from host');
        const sandbox = await createDockerSandbox({
          ...defaults,
          volumes: [
            {
              type: 'bind',
              hostPath: fixture.path,
              containerPath: '/data',
            },
          ],
        });

        try {
          // Should be able to read
          const readResult = await sandbox.run({
            command: 'cat /data/host-file.txt',
          });
          assert.strictEqual(readResult.exitCode, 0);
          assert.strictEqual(readResult.stdout, 'from host');

          // Should not be able to write (read-only)
          const writeResult = await sandbox.run({
            command: 'echo "test" > /data/new-file.txt',
          });
          assert.notStrictEqual(writeResult.exitCode, 0);
          assert.match(writeResult.stderr, /read-only/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches bind volume as read-write when specified', async () => {
        await using fixture = await testbed.directory();
        await fixture.writeFile('host-file.txt', 'from host');
        const sandbox = await createDockerSandbox({
          ...defaults,
          volumes: [
            {
              type: 'bind',
              hostPath: fixture.path,
              containerPath: '/data',
              readOnly: false,
            },
          ],
        });

        try {
          // Should be able to write
          const writeResult = await sandbox.run({
            command: 'echo "container wrote this" > /data/container-file.txt',
          });
          assert.strictEqual(writeResult.exitCode, 0);

          // Verify file exists on host
          const hostContent = await fixture.readFile('container-file.txt');
          assert.strictEqual(hostContent.trim(), 'container wrote this');
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches an existing Docker volume and keeps it after dispose', async () => {
        await using volume = await testbed.volume();

        const writerName = `volume-writer-${crypto.randomUUID()}`;
        const writer = await createDockerSandbox({
          ...defaults,
          name: writerName,
          volumes: [
            {
              type: 'volume',
              name: volume.name,
              containerPath: '/data',
              readOnly: false,
            },
          ],
        });

        try {
          const writeResult = await writer.run({
            command: 'echo "persisted" > /data/file.txt',
          });
          assert.strictEqual(writeResult.exitCode, 0);
        } finally {
          await writer.dispose();
        }

        const readerName = `volume-reader-${crypto.randomUUID()}`;
        const reader = await createDockerSandbox({
          ...defaults,
          name: readerName,
          volumes: [
            {
              type: 'volume',
              name: volume.name,
              containerPath: '/data',
            },
          ],
        });

        try {
          const readResult = await reader.run({
            command: 'cat /data/file.txt',
          });
          assert.strictEqual(readResult.exitCode, 0);
          assert.strictEqual(readResult.stdout, 'persisted\n');
        } finally {
          await reader.dispose();
        }
      });

      it('throws VolumeInspectError for a missing external Docker volume', async () => {
        const volumeName = testVolumeName('deepagents-missing');

        await assert.rejects(
          createDockerSandbox({
            ...defaults,
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
            assert.strictEqual(err.volume, volumeName);
            return true;
          },
        );
      });

      it('creates and removes a managed Docker volume on dispose', async () => {
        const volumeName = testVolumeName('deepagents-managed');
        try {
          const sandbox = await createDockerSandbox({
            ...defaults,
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
            // Root filesystem cleanup keeps Docker's auto-removal in progress
            // after stop returns, while it still holds the volume reference.
            const files = await sandbox.run({
              command:
                'mkdir -p /tmp/disposal-files; for file in {1..5000}; do : > /tmp/disposal-files/$file; done',
            });
            assert.strictEqual(files.exitCode, 0);
            const writeResult = await sandbox.run({
              command: 'echo "managed" > /data/file.txt',
            });
            assert.strictEqual(writeResult.exitCode, 0);
          } finally {
            await sandbox.dispose();
          }

          assert.strictEqual(
            await (await testbed.client()).volumes.find(volumeName),
            undefined,
          );
        } finally {
          await removeDockerVolume(volumeName);
        }
      });

      it('attaches managed Docker volume as read-only by default', async () => {
        const volumeName = testVolumeName('deepagents-managed-ro');
        const sandbox = await createDockerSandbox({
          ...defaults,
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
          const writeResult = await sandbox.run({
            command: 'echo "blocked" > /data/file.txt',
          });
          assert.notStrictEqual(writeResult.exitCode, 0);
          assert.match(writeResult.stderr, /read-only/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('throws VolumeCreateError when managed volume already exists', async () => {
        await using volume = await testbed.volume();

        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            volumes: [
              {
                type: 'volume',
                name: volume.name,
                containerPath: '/data',
                lifecycle: 'managed',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof VolumeCreateError);
            assert.strictEqual(err.name, 'VolumeCreateError');
            assert.strictEqual(err.volume, volume.name);
            return true;
          },
        );
      });

      it('preserves original configuration error when managed volume cleanup fails', async () => {
        const volumeName = testVolumeName('deepagents-cleanup-failure');

        await assert.rejects(
          createDockerSandbox({
            ...defaults,
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
          ...defaults,
          env: { MY_VAR: 'hello', ANOTHER: 'world' },
        });

        try {
          const result = await sandbox.run({
            command: 'echo "$MY_VAR $ANOTHER"',
          });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'hello world\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('env vars persist across exec calls', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          env: { PERSIST_TEST: 'sticky' },
        });

        try {
          const r1 = await sandbox.run({ command: 'echo "$PERSIST_TEST"' });
          const r2 = await sandbox.run({ command: 'echo "$PERSIST_TEST"' });
          assert.strictEqual(r1.stdout, 'sticky\n');
          assert.strictEqual(r2.stdout, 'sticky\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('handles env values with spaces', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          env: { SPACED: 'hello world foo' },
        });

        try {
          const result = await sandbox.run({ command: 'echo "$SPACED"' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'hello world foo\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('handles env values containing equals signs', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          env: { DB_URL: 'host=localhost;port=5432' },
        });

        try {
          const result = await sandbox.run({ command: 'echo "$DB_URL"' });
          assert.strictEqual(result.stdout, 'host=localhost;port=5432\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('works with empty env object', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          env: {},
        });

        try {
          const result = await sandbox.run({ command: 'echo works' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'works\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('rejects env keys containing equals sign before it reaches the engine', async () => {
        // No engine listens here: the error must come from the input alone.
        const environment = {
          DOCKER_HOST: 'unix:///nonexistent/deepagents-sandbox.sock',
        };
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            environment,
            env: { 'FOO=BAR': 'val' },
          }),
          /Invalid environment variable key/,
        );
      });
    });

    describe('resource limits', () => {
      it('applies custom memory and CPU limits', async () => {
        const name = `limits-${crypto.randomUUID()}`;
        const sandbox = await createDockerSandbox({
          ...defaults,
          name,
          resources: {
            ...defaults.resources,
            memory: '256m',
            cpus: 0.5,
          },
        });

        try {
          // Container should work with limits
          const result = await sandbox.run({ command: 'echo "limited"' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'limited\n');
          const found = await (
            await testbed.client()
          ).containers.find(`sandbox-${name}`);
          assert.ok(found, `sandbox-${name} must exist`);
          const container = await found.inspect();
          assert.deepStrictEqual(
            {
              Memory: container.HostConfig?.Memory,
              NanoCpus: container.HostConfig?.NanoCpus,
            },
            { Memory: 256 * 1024 ** 2, NanoCpus: 500_000_000 },
          );
        } finally {
          await sandbox.dispose();
        }
      });

      it('sizes /dev/shm via shmSize', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          resources: { ...defaults.resources, shmSize: '64m' },
        });

        try {
          const result = await sandbox.run({ command: 'df -k /dev/shm' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /65536/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('applies a file-descriptor ulimit to PID 1', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          resources: {
            ...defaults.resources,
            ulimits: ['nofile=512:512'],
          },
        });

        try {
          const result = await sandbox.run({ command: 'cat /proc/1/limits' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /Max open files\s+512\s+512/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('caps the process count via pidsLimit', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          resources: { ...defaults.resources, pidsLimit: 42 },
        });

        try {
          const result = await sandbox.run({
            command:
              'cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max',
          });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, '42\n');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('container runtime', () => {
      it('runs the container under the default runtime when runtime is omitted', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          runtime: 'runc',
        });

        try {
          const result = await sandbox.run({ command: 'echo runc' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'runc\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('passes runtime through to `docker run --runtime`', async () => {
        const bogusRuntime = 'sandbox-nonexistent-runtime';

        await assert.rejects(
          createDockerSandbox({ ...defaults, runtime: bogusRuntime }),
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
          ...defaults,
          network: { mode: 'none' },
        });

        try {
          const result = await sandbox.run({ command: 'ls /sys/class/net' });
          assert.strictEqual(result.exitCode, 0);
          const interfaces = result.stdout.split(/\s+/);
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
          ...defaults,
          network: { hostname: 'sandbox-host' },
        });

        try {
          const result = await sandbox.run({ command: 'hostname' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'sandbox-host\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets custom DNS servers', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          network: { dns: ['1.2.3.4'] },
        });

        try {
          const result = await sandbox.run({ command: 'cat /etc/resolv.conf' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /nameserver\s+1\.2\.3\.4/);
        } finally {
          await sandbox.dispose();
        }
      });

      it('adds host-to-IP mappings with addHost', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          network: { addHost: ['myhost:10.1.2.3'] },
        });

        try {
          const result = await sandbox.run({ command: 'cat /etc/hosts' });
          assert.strictEqual(result.exitCode, 0);
          assert.match(result.stdout, /10\.1\.2\.3\s+myhost/);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('process and workspace', () => {
      it('runs an init process as PID 1 with init:true', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          init: true,
        });

        try {
          const result = await sandbox.run({ command: 'cat /proc/1/comm' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'docker-init\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('uses a custom workdir', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          workdir: '/srv',
        });

        try {
          const result = await sandbox.run({ command: 'pwd' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, '/srv\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('overrides the image entrypoint', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          entrypoint: '/bin/sleep',
          command: ['infinity'],
        });

        try {
          const result = await sandbox.run({ command: 'cat /proc/1/comm' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'sleep\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('sets kernel parameters via sysctls', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          sysctls: { 'net.ipv4.ip_forward': '1' },
        });

        try {
          const result = await sandbox.run({
            command: 'cat /proc/sys/net/ipv4/ip_forward',
          });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, '1\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('attaches container labels', async () => {
        const name = `label-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const sandbox = await createDockerSandbox({
          ...defaults,
          name,
          labels: {
            ...defaults.labels,
            'com.example.role': 'sandbox-test',
          },
        });

        try {
          const found = await (
            await testbed.client()
          ).containers.find(`sandbox-${name}`);
          assert.ok(found, `sandbox-${name} must exist`);
          const container = await found.inspect();
          assert.strictEqual(
            container.Config?.Labels?.['com.example.role'],
            'sandbox-test',
          );
          for (const [key, value] of Object.entries(testbed.defaults.Labels)) {
            assert.strictEqual(container.Config?.Labels?.[key], value);
          }
          assert.strictEqual(container.HostConfig?.Memory, 1024 ** 3);
          assert.strictEqual(container.HostConfig?.NanoCpus, 1_000_000_000);
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
          ...defaults,
          security: { user: '1000:1000' },
        });

        try {
          const result = await sandbox.run({ command: 'id -u' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, '1000\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('mounts a read-only rootfs with a writable tmpfs workspace', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          security: { readOnly: true, tmpfs: ['/workspace', '/tmp'] },
        });

        try {
          await sandbox.writeTextFile({
            path: '/workspace/ok.txt',
            content: 'written',
          });
          assert.strictEqual(
            await sandbox.readTextFile({ path: '/workspace/ok.txt' }),
            'written',
          );

          const rootWrite = await sandbox.run({
            command: 'echo nope > /etc/blocked.txt',
          });
          assert.notStrictEqual(rootWrite.exitCode, 0);
          assert.match(rootWrite.stderr, /read-only file system/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('stops a spawned process as a non-root user on a read-only rootfs', async () => {
        await using sandbox = await createDockerSandbox({
          ...defaults,
          security: { readOnly: true, tmpfs: ['/tmp'], user: '1000:1000' },
        });

        const child = await sandbox.spawn({
          command: 'printf started; sleep 30',
        });
        const { value } = await child.stdout.getReader().read();
        await child.kill();

        assert.strictEqual(new TextDecoder().decode(value), 'started');
        assert.notStrictEqual((await child.wait()).exitCode, 0);
      });

      it('reaches tmpfs and kernel paths through an exec, with null for a missing one', async () => {
        await using sandbox = await createDockerSandbox({
          ...defaults,
          security: { tmpfs: ['/scratch'] },
        });
        await sandbox.writeTextFile({
          path: '/scratch/deep/note.txt',
          content: 'tmpfs',
        });
        const link = await sandbox.run({
          command: 'ln -s note.txt /scratch/deep/link',
        });
        assert.strictEqual(link.exitCode, 0, link.stderr);

        assert.strictEqual(
          await sandbox.readTextFile({ path: '/scratch/deep/link' }),
          'tmpfs',
        );
        assert.deepStrictEqual(
          await sandbox.stat({ path: '/scratch/deep/link' }),
          { type: 'file', size: 5 },
        );
        assert.strictEqual(
          (await sandbox.stat({ path: '/scratch' }))?.type,
          'directory',
        );
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/scratch/missing' }),
          null,
        );
        assert.strictEqual(
          await sandbox.stat({ path: '/scratch/missing' }),
          null,
        );
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/proc/1/comm' }),
          'tail\n',
        );
        assert.strictEqual(
          (await sandbox.stat({ path: '/dev/null' }))?.type,
          'other',
        );
        await assert.rejects(
          Promise.resolve(
            sandbox.writeTextFile({ path: '/scratch/deep', content: 'boom' }),
          ),
          /directory/i,
        );
      });

      it('reports a symbolic link loop as an error, not a hang or a missing path', async () => {
        await using sandbox = await createDockerSandbox(defaults);
        const loop = await sandbox.run({
          command: 'ln -s two /tmp/one; ln -s one /tmp/two',
        });
        assert.strictEqual(loop.exitCode, 0, loop.stderr);

        await assert.rejects(
          Promise.resolve(sandbox.stat({ path: '/tmp/one' })),
          /symbolic link/i,
        );
        await assert.rejects(
          Promise.resolve(sandbox.readBinaryFile({ path: '/tmp/one' })),
          /symbolic link/i,
        );
      });

      it('drops Linux capabilities', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          security: { capDrop: ['ALL'] },
        });

        try {
          await sandbox.run({ command: 'touch /tmp/cap-probe' });
          const chown = await sandbox.run({
            command: 'chown 1000 /tmp/cap-probe',
          });
          assert.notStrictEqual(chown.exitCode, 0);
          assert.match(chown.stderr, /not permitted|operation not permitted/i);
        } finally {
          await sandbox.dispose();
        }
      });

      it('re-grants a capability with capAdd', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          security: { capDrop: ['ALL'], capAdd: ['CHOWN'] },
        });

        try {
          await sandbox.run({ command: 'touch /tmp/cap-probe' });
          const chown = await sandbox.run({
            command: 'chown 1000 /tmp/cap-probe',
          });
          assert.strictEqual(chown.exitCode, 0, chown.stderr);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('Dockerfile strategy', () => {
      it('keeps a character that a chunk of the stderr of docker build ends inside', async () => {
        await using dir = await temporaryFiles.directory('sandbox-dockerfile-');
        const docker = execFileSync('which', ['docker'], {
          encoding: 'utf8',
        }).trim();
        // A euro sign is three bytes, and a pipe can end a chunk inside it.
        await writeFile(
          join(dir.path, 'docker'),
          `#!${process.execPath}
const { spawnSync } = require('node:child_process');
if (process.argv[2] !== 'build') {
  const args = process.argv.slice(2);
  const real = spawnSync(${JSON.stringify(docker)}, args, { stdio: 'inherit' });
  process.exit(real.status);
}
process.stderr.write(Buffer.from([0xe2]));
setTimeout(() => {
  process.stderr.write(Buffer.from([0x82, 0xac]));
  process.exit(1);
}, 200);
`,
          { mode: 0o755 },
        );

        // The sandbox gives the Docker CLI the environment of its process, so
        // only a process of its own can give the CLI this PATH.
        const { stdout } = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `import { createDockerSandbox } from '@deepagents/context';
const options = ${JSON.stringify(defaults)};
const dockerfile = 'FROM bash:5.3-alpine3.24\\nRUN echo split-stderr\\n';
await createDockerSandbox({ ...options, dockerfile }).then(
  (sandbox) => sandbox.dispose(),
  (error) => console.log(error.message),
);`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${dir.path}${delimiter}${process.env.PATH}`,
            },
          },
        );

        assert.match(stdout, /€/);
      });

      it('builds an image from an inline Dockerfile', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          dockerfile:
            'FROM bash:5.3-alpine3.24\nRUN echo inline-build > /built-marker\n',
        });

        try {
          const result = await sandbox.run({ command: 'cat /built-marker' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'inline-build\n');
        } finally {
          await sandbox.dispose();
        }
      });

      it('builds an image from a Dockerfile path', async () => {
        await using dir = await temporaryFiles.directory('sandbox-dockerfile-');
        await writeFile(
          join(dir.path, 'Dockerfile'),
          'FROM bash:5.3-alpine3.24\nRUN echo file-build > /built-marker\n',
        );

        const sandbox = await createDockerSandbox({
          ...defaults,
          dockerfile: join(dir.path, 'Dockerfile'),
          context: dir.path,
        });
        try {
          const result = await sandbox.run({ command: 'cat /built-marker' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'file-build\n');
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('cleanup', () => {
      it('dispose stops and removes container', async () => {
        const name = `dispose-${crypto.randomUUID()}`;
        await using sandbox = await createDockerSandbox({ ...defaults, name });
        const beforeResult = await sandbox.run({ command: 'echo alive' });
        assert.strictEqual(beforeResult.exitCode, 0);

        await sandbox.dispose();

        const client = await testbed.client();
        assert.strictEqual(
          await client.containers.find(`sandbox-${name}`),
          undefined,
        );
      });

      it('dispose resolves only after the engine removed a slow container, so its bind mount is free', async () => {
        await using fixture = await testbed.directory();
        const name = `dispose-slow-${crypto.randomUUID()}`;
        const sandbox = await createDockerSandbox({
          ...defaults,
          name,
          volumes: [
            {
              type: 'bind',
              hostPath: fixture.path,
              containerPath: '/data',
              readOnly: false,
            },
          ],
        });
        // Root filesystem cleanup keeps Docker's auto-removal in progress after
        // stop returns.
        const files = await sandbox.run({
          command:
            'echo owned > /data/owned.txt; mkdir -p /tmp/many; for file in {1..5000}; do : > /tmp/many/$file; done',
        });
        assert.strictEqual(files.exitCode, 0, files.stderr);

        await sandbox.dispose();

        const client = await testbed.client();
        assert.strictEqual(
          await client.containers.find(`sandbox-${name}`),
          undefined,
        );
      });

      it('dispose leaves a container that is not auto-removed stopped, without waiting for its removal', async () => {
        const name = `dispose-kept-${crypto.randomUUID()}`;
        await using container = await testbed.start(
          { Image: 'bash:5.3-alpine3.24', Cmd: ['tail', '-f', '/dev/null'] },
          { name: `sandbox-${name}` },
        );
        const sandbox = await createDockerSandbox({ ...defaults, name });

        await sandbox.dispose();

        assert.strictEqual((await container.inspect()).State?.Running, false);
      });

      it('dispose is idempotent (can call multiple times)', async () => {
        const sandbox = await createDockerSandbox(defaults);

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
        const container = await (
          await testbed.client()
        ).containers.find(containerId);
        await container?.remove({ force: true });
      }

      async function containerNames(name: string): Promise<string[]> {
        const client = await testbed.client();
        const containers = await client.containers.list({
          all: true,
          filters: { name: [`^/${name}$`] },
        });
        return containers.flatMap(({ Names }) => Names ?? []);
      }

      it('names the container `sandbox-<name>`', async () => {
        const name = uniqueName();
        const sandbox = await createDockerSandbox({ ...defaults, name });

        try {
          assert.deepStrictEqual(await containerNames(`sandbox-${name}`), [
            `/sandbox-${name}`,
          ]);
        } finally {
          await sandbox.dispose();
          await removeContainer(`sandbox-${name}`);
        }
      });

      it('attaches to an existing running container and skips installers', async () => {
        const name = uniqueName();
        const first = await createDockerSandbox({
          ...defaults,
          name,
          installers: [pkg(['curl'])],
        });

        let second: DisposableSandbox | undefined;
        try {
          await first.run({ command: 'echo first-run > /workspace/marker' });

          second = await createDockerSandbox({
            ...defaults,
            name,
            // Different installers would normally rerun; attach must skip them.
            installers: [pkg(['nonexistent-package-should-not-install'])],
          });

          const marker = await second.run({ command: 'cat /workspace/marker' });
          assert.strictEqual(marker.exitCode, 0);
          assert.strictEqual(marker.stdout, 'first-run\n');

          const curl = await second.run({ command: 'curl --version' });
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
            createDockerSandbox({ ...defaults, name }),
            createDockerSandbox({ ...defaults, name }),
          ]);

          // One handle writes; the other must read it back — proving both
          // resolved to the same underlying container.
          await a.run({ command: 'echo converged > /workspace/marker' });
          const read = await b.run({ command: 'cat /workspace/marker' });
          assert.strictEqual(read.exitCode, 0);
          assert.strictEqual(read.stdout, 'converged\n');

          // Exactly one container exists with that name.
          assert.deepStrictEqual(await containerNames(`sandbox-${name}`), [
            `/sandbox-${name}`,
          ]);
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
        await using container = await testbed.start(
          { Image: 'bash:5.3-alpine3.24', Cmd: ['tail', '-f', '/dev/null'] },
          { name: `sandbox-${name}` },
        );
        await container.stop();

        const sandbox = await createDockerSandbox({ ...defaults, name });
        try {
          const result = await sandbox.run({ command: 'echo back-online' });
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.stdout, 'back-online\n');
          const found = await (
            await testbed.client()
          ).containers.find(`sandbox-${name}`);
          assert.ok(found, `sandbox-${name} must exist`);
          assert.strictEqual(found.id, container.id);
          assert.strictEqual((await found.inspect()).State?.Running, true);
        } finally {
          await sandbox.dispose();
        }
      });

      it('rejects names that are not Docker-legal before it reaches the engine', async () => {
        // No engine listens here: the error must come from the input alone.
        const environment = {
          DOCKER_HOST: 'unix:///nonexistent/deepagents-sandbox.sock',
        };
        await assert.rejects(
          createDockerSandbox({ ...defaults, environment, name: '' }),
          /Invalid container name/,
        );
        await assert.rejects(
          createDockerSandbox({ ...defaults, environment, name: 'has spaces' }),
          /Invalid container name/,
        );
        await assert.rejects(
          createDockerSandbox({ ...defaults, environment, name: 'has/slash' }),
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
            createDockerSandbox({ ...defaults, name }),
            createDockerSandbox({ ...defaults, name }),
          ]);

          const ra = await a.run({ command: 'echo a' });
          const rb = await b.run({ command: 'echo b' });
          assert.strictEqual(ra.stdout, 'a\n');
          assert.strictEqual(rb.stdout, 'b\n');

          assert.deepStrictEqual(await containerNames(containerId), [
            `/${containerId}`,
          ]);

          await a.dispose();
        } finally {
          await removeContainer(containerId);
        }
      });

      it('falls back to random naming when no name is provided', async () => {
        const a = await createDockerSandbox(defaults);
        const b = await createDockerSandbox(defaults);
        try {
          await a.run({ command: 'echo a' });
          await b.run({ command: 'echo b' });
        } finally {
          await a.dispose();
          await b.dispose();
        }
      });
    });
  });

  describe('createDockerSandbox + createBashTool', () => {
    it('returns bash tool and sandbox', async () => {
      const backend = await createDockerSandbox({
        ...defaults,
        installers: [],
      });
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
      const backend = await createDockerSandbox(defaults);
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.run({ command: 'echo "from container"' });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'from container\n');
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects installers option', async () => {
      const backend = await createDockerSandbox({
        ...defaults,
        installers: [pkg(['curl'])],
      });
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.run({ command: 'curl --version' });
        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /curl/i);
      } finally {
        await sandbox.dispose();
      }
    });

    it('passes env vars through to container', async () => {
      const backend = await createDockerSandbox({
        ...defaults,
        env: { TOOL_VAR: 'via-tool' },
      });
      const { sandbox } = await createBashTool({ sandbox: backend });

      try {
        const result = await sandbox.run({ command: 'echo "$TOOL_VAR"' });
        assert.strictEqual(result.stdout, 'via-tool\n');
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects volumes option', async () => {
      await using fixture = await testbed.directory();
      const tempDir = fixture.path;
      await fixture.writeFile('test.txt', 'mounted content');

      const backend = await createDockerSandbox({
        ...defaults,
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
        const result = await sandbox.run({ command: 'cat /mounted/test.txt' });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'mounted content');
      } finally {
        await sandbox.dispose();
      }
    });
  });

  describe('useSandbox', () => {
    it('auto-disposes sandbox on successful completion', async () => {
      const captured: DisposableSandbox[] = [];

      const result = await useSandbox(defaults, async (sandbox) => {
        captured.push(sandbox);
        const output = await sandbox.run({
          command: 'echo "hello from useSandbox"',
        });
        return output.stdout;
      });

      assert.strictEqual(result, 'hello from useSandbox\n');

      // Verify sandbox is disposed (command should fail)
      const captured1 = captured.at(0);
      if (captured1) {
        try {
          await captured1.run({ command: 'echo test' });
          // If no error, container might still be stopping - that's ok
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('auto-disposes sandbox even when function throws', async () => {
      const captured: DisposableSandbox[] = [];

      await assert.rejects(
        useSandbox(defaults, async (sandbox) => {
          captured.push(sandbox);
          // Verify container is running
          const result = await sandbox.run({ command: 'echo alive' });
          assert.strictEqual(result.exitCode, 0);
          // Now throw
          throw new Error('intentional test error');
        }),
        /intentional test error/,
      );

      // Verify sandbox is disposed (command should fail)
      const captured2 = captured.at(0);
      if (captured2) {
        try {
          await captured2.run({ command: 'echo test' });
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('returns the value from the callback', async () => {
      const result = await useSandbox(
        { ...defaults, installers: [pkg(['curl'])] },
        async (sandbox) => {
          const output = await sandbox.run({ command: 'curl --version' });
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
          createDockerSandbox({
            ...defaults,
            installers: [npm('prettier')],
          }),
          (err: Error) => {
            assert.ok(err instanceof MissingRuntimeError);
            assert.ok(err instanceof DockerSandboxError);
            assert.strictEqual(err.runtime, 'npm');
            assert.deepStrictEqual(err.required, ['node', 'npm']);
            return true;
          },
        );
      });

      it('auto-installs nodejs+npm when ensureRuntime is true', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          installers: [npm('cowsay', { ensureRuntime: true })],
        });
        try {
          const node = await sandbox.run({ command: 'which node' });
          assert.strictEqual(node.exitCode, 0);
          const cli = await sandbox.run({ command: 'which cowsay' });
          assert.strictEqual(cli.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });

      it('skips ensureRuntime when node base image already has node+npm', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          image: 'node:lts-bookworm-slim',
          installers: [npm('cowsay')],
        });
        try {
          const result = await sandbox.run({ command: 'cowsay -t hi' });
          assert.strictEqual(result.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('pip', () => {
      it('throws MissingRuntimeError on alpine without ensureRuntime', async () => {
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            installers: [pip('requests')],
          }),
          (err: Error) => {
            assert.ok(err instanceof MissingRuntimeError);
            assert.strictEqual(err.runtime, 'pip');
            assert.deepStrictEqual(err.required, ['python3', 'pip3']);
            return true;
          },
        );
      });

      it('auto-installs python3+pip when ensureRuntime is true', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          installers: [pip('requests', { ensureRuntime: true })],
        });
        try {
          const result = await sandbox.run({
            command:
              'python3 -c "import requests; print(requests.__version__)"',
          });
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
          ...defaults,
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
          const curl = await sandbox.run({ command: 'which curl' });
          assert.strictEqual(curl.exitCode, 0);
          const yq = await sandbox.run({ command: 'yq --version' });
          assert.strictEqual(yq.exitCode, 0);
        } finally {
          await sandbox.dispose();
        }
      });
    });

    describe('apt-get update is run only once across installers', () => {
      it('multiple ensureTool / pkg calls do not re-run apt-get update', async () => {
        const sandbox = await createDockerSandbox({
          ...defaults,
          image: 'debian:stable-slim',
          installers: [pkg(['curl']), pkg(['jq'])],
        });
        try {
          const r1 = await sandbox.run({ command: 'which curl' });
          assert.strictEqual(r1.exitCode, 0);
          const r2 = await sandbox.run({ command: 'which jq' });
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
            ...defaults,
            installers: [
              urlBinary({
                name: 'bogus',
                url: 'https://invalid.example.invalid/does-not-exist.tar.gz',
              }),
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof InstallError);
            assert.strictEqual(err.target, 'bogus');
            assert.strictEqual(err.source, 'url');
            return true;
          },
        );
      });
    });
  });

  describe('error classes', () => {
    describe('VolumePathError', () => {
      it('identifies the missing bind source when another source is its prefix', async () => {
        await using fixture = await testbed.directory();
        const missing = `${fixture.path}/missing`;
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            volumes: [
              {
                type: 'bind',
                hostPath: fixture.path,
                containerPath: '/present',
              },
              { type: 'bind', hostPath: missing, containerPath: '/missing' },
            ],
          }),
          (error) =>
            error instanceof VolumePathError &&
            error.source === missing &&
            error.containerPath === '/missing',
        );
      });

      it('throws VolumePathError for non-existent bind host path', async () => {
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
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
            assert.strictEqual(
              err.source,
              '/nonexistent/path/that/does/not/exist',
            );
            assert.strictEqual(err.containerPath, '/app');
            assert.strictEqual(err.reason, 'hostPath does not exist on host');
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
              ...defaults,
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
              assert.strictEqual(err.source, tempDir);
              assert.strictEqual(
                err.reason,
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
            ...defaults,
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
            assert.strictEqual(
              err.reason,
              'containerPath must not contain commas',
            );
            return true;
          },
        );
      });

      it('throws VolumePathError for volume subpaths containing commas', async () => {
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
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
            assert.strictEqual(err.reason, 'subPath must not contain commas');
            return true;
          },
        );
      });
    });

    describe('PackageInstallError', () => {
      it('throws PackageInstallError for invalid package', async () => {
        await assert.rejects(
          createDockerSandbox({
            ...defaults,
            installers: [pkg(['nonexistent-package-xyz-12345'])],
          }),
          (err: Error) => {
            assert.ok(err instanceof PackageInstallError);
            assert.ok(err instanceof DockerSandboxError);
            assert.strictEqual(err.name, 'PackageInstallError');
            assert.deepStrictEqual(err.packages, [
              'nonexistent-package-xyz-12345',
            ]);
            assert.strictEqual(err.image, 'bash:5.3-alpine3.24');
            assert.strictEqual(err.packageManager, 'apk');
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
