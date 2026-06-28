import spawn from 'nano-spawn';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  AppleContainerSandboxError,
  AppleContainerVolumePathError,
  type DisposableSandbox,
  createAppleContainerSandbox,
  pkg,
  useAppleContainerSandbox,
} from '@deepagents/context';

const ALPINE = 'docker.io/library/alpine:latest';

/**
 * The Apple `container` backend only works on Apple silicon (macOS 26+) with
 * the service running and a guest kernel configured. Probe by actually booting
 * a throwaway container — anything short of that (Linux CI, stopped service,
 * missing kernel) returns false and skips the runtime suite, mirroring the
 * Docker suite's `isDockerAvailable()` guard.
 */
async function isAppleContainerUsable(): Promise<boolean> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
  const name = `probe-usable-${process.pid}`;
  try {
    await spawn('container', ['system', 'status']);
    await spawn('container', [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      ALPINE,
      'tail',
      '-f',
      '/dev/null',
    ]);
    return true;
  } catch {
    return false;
  } finally {
    await spawn('container', ['stop', name]).catch(() => {});
  }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Pure input validation — runs everywhere (no container runtime needed) since
 * every case throws before any `container` CLI call is made.
 */
describe('createAppleContainerSandbox validation', () => {
  it('rejects an invalid container name', async () => {
    await assert.rejects(
      createAppleContainerSandbox({ name: 'bad name!' }),
      AppleContainerSandboxError,
    );
  });

  it('rejects an invalid env var key', async () => {
    await assert.rejects(
      createAppleContainerSandbox({ env: { 'BAD=KEY': 'v' } }),
      AppleContainerSandboxError,
    );
  });

  it('rejects a non-absolute containerPath', async () => {
    await assert.rejects(
      createAppleContainerSandbox({
        volumes: [
          { type: 'bind', hostPath: tmpdir(), containerPath: 'relative' },
        ],
      }),
      AppleContainerVolumePathError,
    );
  });

  it('rejects a bind mount whose host path does not exist', async () => {
    await assert.rejects(
      createAppleContainerSandbox({
        volumes: [
          {
            type: 'bind',
            hostPath: '/definitely/not/a/real/path/xyz',
            containerPath: '/data',
          },
        ],
      }),
      AppleContainerVolumePathError,
    );
  });

  it('rejects duplicate containerPaths', async () => {
    await assert.rejects(
      createAppleContainerSandbox({
        volumes: [
          { type: 'bind', hostPath: tmpdir(), containerPath: '/data' },
          { type: 'bind', hostPath: tmpdir(), containerPath: '/data' },
        ],
      }),
      AppleContainerVolumePathError,
    );
  });
});

describe('Apple container sandbox (runtime)', async () => {
  const usable = await isAppleContainerUsable();
  if (!usable) {
    console.log(
      'Skipping Apple container runtime tests: `container` not usable on this host',
    );
    return;
  }

  it('runs a command and captures stdout/exit code', async () => {
    await using sandbox = await createAppleContainerSandbox();
    const result = await sandbox.executeCommand('echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
  });

  it('defaults to an Alpine image', async () => {
    await using sandbox = await createAppleContainerSandbox();
    const result = await sandbox.executeCommand('cat /etc/os-release');
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /alpine/i);
  });

  it('runs commands from /workspace', async () => {
    await using sandbox = await createAppleContainerSandbox();
    const result = await sandbox.executeCommand('pwd');
    assert.strictEqual(result.stdout.trim(), '/workspace');
  });

  it('propagates a non-zero exit code', async () => {
    await using sandbox = await createAppleContainerSandbox();
    const result = await sandbox.executeCommand('exit 3');
    assert.strictEqual(result.exitCode, 3);
  });

  it('passes environment variables', async () => {
    await using sandbox = await createAppleContainerSandbox({
      env: { GREETING: 'hi-there' },
    });
    const result = await sandbox.executeCommand('echo "$GREETING"');
    assert.strictEqual(result.stdout.trim(), 'hi-there');
  });

  it('round-trips files via writeFiles/readFile', async () => {
    await using sandbox = await createAppleContainerSandbox();
    await sandbox.writeFiles([
      { path: '/workspace/nested/dir/hello.txt', content: 'file-contents\n' },
    ]);
    const content = await sandbox.readFile('/workspace/nested/dir/hello.txt');
    assert.strictEqual(content, 'file-contents\n');
  });

  it('round-trips a large file across multiple write chunks', async () => {
    await using sandbox = await createAppleContainerSandbox();
    const big = `${'x'.repeat(50_000)}\n${'y'.repeat(50_000)}`;
    await sandbox.writeFiles([{ path: '/workspace/big.txt', content: big }]);
    const read = await sandbox.readFile('/workspace/big.txt');
    assert.strictEqual(read, big);
  });

  it('creates and removes a managed named volume', async () => {
    const volName = `mvol-${process.pid}`;
    await useAppleContainerSandbox(
      {
        volumes: [
          {
            type: 'volume',
            name: volName,
            containerPath: '/data',
            lifecycle: 'managed',
            readOnly: false,
          },
        ],
      },
      async (sandbox) => {
        const write = await sandbox.executeCommand('echo persisted > /data/m');
        assert.strictEqual(write.exitCode, 0);
        const read = await sandbox.executeCommand('cat /data/m');
        assert.strictEqual(read.stdout.trim(), 'persisted');
      },
    );
    const ls = await spawn('container', ['volume', 'ls', '--format', 'json']);
    assert.ok(
      !ls.stdout.includes(volName),
      'managed volume should be removed on dispose',
    );
  });

  it('streams output via spawn()', async () => {
    await using sandbox = await createAppleContainerSandbox();
    assert.ok(sandbox.spawn, 'backend should expose spawn');
    const proc = sandbox.spawn('for i in 1 2 3; do echo "line$i"; done');
    const [stdout, exit] = await Promise.all([
      readStream(proc.stdout),
      proc.exit,
    ]);
    assert.strictEqual(exit.success, true);
    assert.deepStrictEqual(stdout.trim().split('\n'), [
      'line1',
      'line2',
      'line3',
    ]);
  });

  it('runs installers (pkg) against the real package manager', async () => {
    await useAppleContainerSandbox(
      { image: ALPINE, installers: [pkg(['jq'])] },
      async (sandbox) => {
        const result = await sandbox.executeCommand('echo \'{"a":1}\' | jq .a');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), '1');
      },
    );
  });

  it('builds and runs an inline Dockerfile image', async () => {
    await useAppleContainerSandbox(
      {
        dockerfile: `FROM ${ALPINE}\nRUN echo built-by-dockerfile > /etc/built-marker\n`,
      },
      async (sandbox) => {
        const result = await sandbox.executeCommand('cat /etc/built-marker');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout.trim(), 'built-by-dockerfile');
      },
    );
  });

  it('mounts a read-only host bind volume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apple-sbx-bind-'));
    await writeFile(join(dir, 'note.txt'), 'from-host');
    try {
      await useAppleContainerSandbox(
        {
          volumes: [
            { type: 'bind', hostPath: dir, containerPath: '/mnt/data' },
          ],
        },
        async (sandbox) => {
          const read = await sandbox.executeCommand('cat /mnt/data/note.txt');
          assert.strictEqual(read.stdout.trim(), 'from-host');
          const write = await sandbox.executeCommand(
            'echo x > /mnt/data/should-fail 2>&1',
          );
          assert.notStrictEqual(write.exitCode, 0);
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses a stably-named container across handles', async () => {
    const name = `reuse-${process.pid}`;
    const first = await createAppleContainerSandbox({ name });
    let second: DisposableSandbox | undefined;
    try {
      await first.writeFiles([
        { path: '/workspace/marker.txt', content: 'shared' },
      ]);
      second = await createAppleContainerSandbox({ name });
      const seen = await second.readFile('/workspace/marker.txt');
      assert.strictEqual(seen, 'shared');
    } finally {
      await (second ?? first).dispose();
    }
  });
});
