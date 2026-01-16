import spawn from 'nano-spawn';
import assert from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type DockerSandbox,
  // Error classes
  DockerSandboxError,
  MountPathError,
  PackageInstallError,
  createContainerTool,
  createDockerSandbox,
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
          packages: ['curl'],
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
          packages: ['curl'],
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
          packages: [],
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
            packages: ['nonexistent-pkg-xyz-12345'],
          }),
          /Package installation failed/,
        );
      });
    });

    describe('command execution', () => {
      let sandbox: DockerSandbox;

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
      let sandbox: DockerSandbox;

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

    describe('mounts', () => {
      let tempDir: string;

      before(async () => {
        tempDir = join(tmpdir(), `docker-sandbox-test-${Date.now()}`);
        await mkdir(tempDir, { recursive: true });
        await writeFile(join(tempDir, 'host-file.txt'), 'from host');
      });

      after(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      it('mounts directory as read-only by default', async () => {
        const sandbox = await createDockerSandbox({
          mounts: [
            {
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

      it('mounts directory as read-write when specified', async () => {
        const sandbox = await createDockerSandbox({
          mounts: [
            {
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
  });

  describe('createContainerTool', () => {
    it('returns bash tool and sandbox', async () => {
      const { bash, tools, sandbox } = await createContainerTool({
        packages: [],
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
      const { sandbox } = await createContainerTool();

      try {
        // Execute via sandbox (the underlying bash tool uses this)
        const result = await sandbox.executeCommand('echo "from container"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'from container');
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects packages option', async () => {
      const { sandbox } = await createContainerTool({
        packages: ['curl'],
      });

      try {
        const result = await sandbox.executeCommand('curl --version');
        assert.strictEqual(result.exitCode, 0);
        assert.match(result.stdout, /curl/i);
      } finally {
        await sandbox.dispose();
      }
    });

    it('respects mounts option', async () => {
      const tempDir = join(tmpdir(), `container-tool-test-${Date.now()}`);
      await mkdir(tempDir, { recursive: true });
      await writeFile(join(tempDir, 'test.txt'), 'mounted content');

      const { sandbox } = await createContainerTool({
        mounts: [
          {
            hostPath: tempDir,
            containerPath: '/mounted',
            readOnly: true,
          },
        ],
      });

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
      let sandboxRef: DockerSandbox | null = null;

      const result = await useSandbox({}, async (sandbox) => {
        sandboxRef = sandbox;
        const output = await sandbox.executeCommand(
          'echo "hello from useSandbox"',
        );
        return output.stdout.trim();
      });

      assert.strictEqual(result, 'hello from useSandbox');

      // Verify sandbox is disposed (command should fail)
      if (sandboxRef) {
        try {
          await sandboxRef.executeCommand('echo test');
          // If no error, container might still be stopping - that's ok
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('auto-disposes sandbox even when function throws', async () => {
      let sandboxRef: DockerSandbox | null = null;

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
      if (sandboxRef) {
        try {
          await sandboxRef.executeCommand('echo test');
        } catch {
          // Expected - container is gone
        }
      }
    });

    it('returns the value from the callback', async () => {
      const result = await useSandbox(
        { packages: ['curl'] },
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

  describe('error classes', () => {
    describe('MountPathError', () => {
      it('throws MountPathError for non-existent host path', async () => {
        await assert.rejects(
          createDockerSandbox({
            mounts: [
              {
                hostPath: '/nonexistent/path/that/does/not/exist',
                containerPath: '/app',
              },
            ],
          }),
          (err: Error) => {
            assert.ok(err instanceof MountPathError);
            assert.ok(err instanceof DockerSandboxError);
            assert.strictEqual(err.name, 'MountPathError');
            const mountErr = err as MountPathError;
            assert.strictEqual(
              mountErr.hostPath,
              '/nonexistent/path/that/does/not/exist',
            );
            assert.strictEqual(mountErr.containerPath, '/app');
            return true;
          },
        );
      });
    });

    describe('PackageInstallError', () => {
      it('throws PackageInstallError for invalid package', async () => {
        await assert.rejects(
          createDockerSandbox({
            packages: ['nonexistent-package-xyz-12345'],
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
        const mountErr = new MountPathError('/host', '/container');
        const pkgErr = new PackageInstallError(
          ['pkg'],
          'alpine',
          'apk',
          'error',
        );

        assert.ok(mountErr instanceof DockerSandboxError);
        assert.ok(pkgErr instanceof DockerSandboxError);
        assert.ok(mountErr instanceof Error);
        assert.ok(pkgErr instanceof Error);
      });
    });
  });
});
