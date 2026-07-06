import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  MICROSANDBOX_DEFAULT_DESTINATION,
  MicrosandboxSandboxError,
  createBashTool,
  createMicrosandboxSandbox,
} from '@deepagents/context';

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as DynamicImport;

type MicrosandboxSdk = typeof import('microsandbox');

async function importMicrosandboxSdk(): Promise<MicrosandboxSdk | undefined> {
  try {
    return (await dynamicImport('microsandbox')) as MicrosandboxSdk;
  } catch {
    return undefined;
  }
}

/**
 * Import success is not enough — the runtime needs hardware virtualization
 * (Apple silicon / Linux KVM), so the probe boots a real throwaway microVM,
 * mirroring the Apple container suite's usability guard.
 */
async function isMicrosandboxUsable(): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }
  const sdk = await importMicrosandboxSdk();
  if (!sdk) return false;
  try {
    await using probe = await sdk.Sandbox.builder(
      `deepagents-probe-${process.pid}`,
    )
      .image('alpine')
      .ephemeral(true)
      .replace()
      .create();
    const result = await probe.shell('echo ok');
    return result.success;
  } catch {
    return false;
  }
}

async function readAllText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function readFirstChunk(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  try {
    const { value, done } = await reader.read();
    if (done || !value) throw new Error('stream closed without a chunk');
    return new TextDecoder().decode(value);
  } finally {
    reader.releaseLock();
  }
}

describe('Microsandbox Sandbox', async () => {
  const usable = await isMicrosandboxUsable();
  if (!usable) {
    console.log(
      'Skipping microsandbox live tests: runtime unavailable (requires the microsandbox package and Apple silicon or Linux with KVM)',
    );
  }

  describe('option validation', () => {
    it('rejects names longer than 128 UTF-8 bytes', async () => {
      await assert.rejects(
        createMicrosandboxSandbox({ name: 'x'.repeat(129) }),
        MicrosandboxSandboxError,
      );
    });

    it('rejects "replace" without "name"', async () => {
      await assert.rejects(
        createMicrosandboxSandbox({ replace: true }),
        MicrosandboxSandboxError,
      );
    });
  });

  describe('createMicrosandboxSandbox', { skip: !usable }, () => {
    describe('command execution', () => {
      it('captures stdout and preserves exit code on success', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const result = await sandbox.executeCommand('printf "hello"');
        assert.deepStrictEqual(result, {
          stdout: 'hello',
          stderr: '',
          exitCode: 0,
        });
      });

      it('preserves non-zero exit codes and stderr', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const result = await sandbox.executeCommand(
          'echo "expected failure" >&2; exit 42',
        );
        assert.strictEqual(result.exitCode, 42);
        assert.match(result.stderr, /expected failure/);
      });

      it('returns the aborted result without waiting for the command', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const controller = new AbortController();
        const pending = sandbox.executeCommand('sleep 30', {
          signal: controller.signal,
        });
        controller.abort();
        const started = Date.now();
        const result = await pending;
        assert.deepStrictEqual(result, {
          stdout: '',
          stderr: 'Command aborted',
          exitCode: 1,
        });
        assert.ok(
          Date.now() - started < 25_000,
          'abort must kill the guest command instead of waiting it out',
        );
      });

      it('resolves exit code 124 when commandTimeout elapses', async () => {
        await using sandbox = await createMicrosandboxSandbox({
          commandTimeout: 1_000,
        });
        const result = await sandbox.executeCommand('sleep 30');
        assert.strictEqual(result.exitCode, 124);
        assert.match(result.stderr, /timed out/);
      });
    });

    describe('file operations', () => {
      it('writes and reads files round trip, creating nested parents', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        await sandbox.writeFiles([
          { path: '/workspace/a/b/c.txt', content: 'nested content' },
          { path: '/tmp/deepagents-msb-file.txt', content: 'flat content' },
          {
            path: '/tmp/deepagents-msb-buf.txt',
            content: Buffer.from('buffer content'),
          },
        ]);
        assert.strictEqual(
          await sandbox.readFile('/workspace/a/b/c.txt'),
          'nested content',
        );
        assert.strictEqual(
          await sandbox.readFile('/tmp/deepagents-msb-file.txt'),
          'flat content',
        );
        assert.strictEqual(
          await sandbox.readFile('/tmp/deepagents-msb-buf.txt'),
          'buffer content',
        );
      });
    });

    describe('failure modes', () => {
      it('exit resolves with signal info when aborted mid-stream', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const controller = new AbortController();
        const child = sandbox.spawn(
          'printf "hi\\n"; sleep 30; printf "bye\\n"',
          {
            signal: controller.signal,
          },
        );

        assert.match(await readFirstChunk(child.stdout), /hi/);

        const drained = readAllText(child.stdout);
        controller.abort();

        const info = await child.exit;
        assert.strictEqual(info.success, false);
        assert.strictEqual(info.signal, 'SIGKILL');
        await drained;
      });

      it('exit resolves with non-zero code on command failure', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const child = sandbox.spawn('exit 42');
        await readAllText(child.stdout);
        await readAllText(child.stderr);
        assert.deepStrictEqual(await child.exit, {
          code: 42,
          signal: null,
          success: false,
        });
      });

      it('stdout and stderr both close after the child exits', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const child = sandbox.spawn('echo hi; echo err >&2');
        const [out, err, info] = await Promise.all([
          readAllText(child.stdout),
          readAllText(child.stderr),
          child.exit,
        ]);
        assert.strictEqual(out.trim(), 'hi');
        assert.strictEqual(err.trim(), 'err');
        assert.deepStrictEqual(info, { code: 0, signal: null, success: true });
      });
    });

    describe('live streaming', () => {
      it('delivers stdout bytes before the child exits', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const child = sandbox.spawn('printf "hi\\n"; sleep 2; printf "bye\\n"');

        const winner = await Promise.race([
          readFirstChunk(child.stdout).then(() => 'chunk' as const),
          child.exit.then(() => 'exit' as const),
        ]);
        assert.strictEqual(
          winner,
          'chunk',
          'first stdout chunk must arrive before the child exits (proves live streaming)',
        );

        const rest = await readAllText(child.stdout);
        const info = await child.exit;
        assert.match(rest, /bye/);
        assert.strictEqual(info.success, true);
      });

      it('streams stderr independently of stdout', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const child = sandbox.spawn(
          'echo "to stdout"; echo "to stderr" >&2; echo "also stdout"',
        );
        const [out, err] = await Promise.all([
          readAllText(child.stdout),
          readAllText(child.stderr),
          child.exit,
        ]);
        assert.deepStrictEqual(out.trim().split('\n'), [
          'to stdout',
          'also stdout',
        ]);
        assert.strictEqual(err.trim(), 'to stderr');
      });
    });

    describe('SpawnOptions', () => {
      it('forwards env into the child', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const child = sandbox.spawn('printf "%s\\n" "$MY_VAR"', {
          env: { MY_VAR: 'hello-from-host' },
        });
        const text = await readAllText(child.stdout);
        const info = await child.exit;
        assert.strictEqual(text.trim(), 'hello-from-host');
        assert.strictEqual(info.success, true);
      });

      it('forwards cwd into the child', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        assert.ok(sandbox.spawn);
        const cwd = '/tmp/deepagents-msb-cwd';
        const mkdir = await sandbox.executeCommand(`mkdir -p ${cwd}`);
        assert.strictEqual(mkdir.exitCode, 0);

        const child = sandbox.spawn('pwd', { cwd });
        const text = await readAllText(child.stdout);
        const info = await child.exit;
        assert.strictEqual(text.trim(), cwd);
        assert.strictEqual(info.success, true);
      });
    });

    describe('lifecycle', () => {
      it('resumes a named sandbox with rootfs state intact after dispose', async () => {
        const sdk = (await importMicrosandboxSdk()) as MicrosandboxSdk;
        const name = `deepagents-test-${randomUUID()}`;
        try {
          const first = await createMicrosandboxSandbox({ name });
          try {
            await first.writeFiles([
              { path: '/workspace/persisted.txt', content: 'still here' },
            ]);
          } finally {
            await first.dispose();
          }

          const second = await createMicrosandboxSandbox({ name });
          try {
            assert.strictEqual(
              await second.readFile('/workspace/persisted.txt'),
              'still here',
            );
          } finally {
            await second.dispose();
          }
        } finally {
          await sdk.Sandbox.remove(name).catch(() => {});
        }
      });

      it('removes an unnamed sandbox entirely on dispose', async () => {
        const sdk = (await importMicrosandboxSdk()) as MicrosandboxSdk;
        const namesBefore = new Set(
          (await sdk.Sandbox.list()).map((handle) => handle.name),
        );

        const sandbox = await createMicrosandboxSandbox();
        await sandbox.executeCommand('true');
        await sandbox.dispose();

        const leftovers = (await sdk.Sandbox.list())
          .map((handle) => handle.name)
          .filter(
            (name) =>
              name.startsWith('deepagents-msb-') && !namesBefore.has(name),
          );
        assert.deepStrictEqual(leftovers, []);
      });
    });
  });

  describe('readiness', { skip: !usable }, () => {
    it('returns the sandbox once the readiness hook resolves', async () => {
      await using sandbox = await createMicrosandboxSandbox({
        readiness: async (booting) => {
          const marker = await booting.executeCommand(
            'echo ok > /tmp/readiness-ran.txt',
          );
          assert.strictEqual(marker.exitCode, 0);
        },
      });
      assert.strictEqual(
        await sandbox.readFile('/tmp/readiness-ran.txt'),
        'ok\n',
      );
    });

    it('disposes the sandbox and rethrows when the hook fails', async () => {
      const sdk = (await importMicrosandboxSdk()) as MicrosandboxSdk;
      const name = `deepagents-test-${randomUUID()}`;
      try {
        await assert.rejects(
          createMicrosandboxSandbox({
            name,
            readiness: () => {
              throw new Error('daemon never came up');
            },
          }),
          /daemon never came up/,
        );

        const handle = await sdk.Sandbox.get(name);
        assert.strictEqual(
          handle.status,
          'stopped',
          'a failing readiness hook must dispose (stop) the named sandbox',
        );
      } finally {
        await sdk.Sandbox.remove(name).catch(() => {});
      }
    });
  });

  describe(
    'createMicrosandboxSandbox + createBashTool',
    { skip: !usable },
    () => {
      it('wires the workdir as the bash destination without manual mkdir', async () => {
        const backend = await createMicrosandboxSandbox();
        try {
          const agent = await createBashTool({
            sandbox: backend,
            destination: MICROSANDBOX_DEFAULT_DESTINATION,
          });
          assert.ok(
            agent.sandbox.spawn,
            'createBashTool must forward spawn from the backend',
          );

          const result = await agent.sandbox.executeCommand(
            `cd ${MICROSANDBOX_DEFAULT_DESTINATION} && pwd`,
          );
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(
            result.stdout.trim(),
            MICROSANDBOX_DEFAULT_DESTINATION,
          );
        } finally {
          await backend.dispose();
        }
      });

      it('streams live stdout through the wrapper', async () => {
        const backend = await createMicrosandboxSandbox();
        try {
          const agent = await createBashTool({
            sandbox: backend,
            destination: MICROSANDBOX_DEFAULT_DESTINATION,
          });
          assert.ok(agent.sandbox.spawn);
          const child = agent.sandbox.spawn(
            'printf "hi\\n"; sleep 2; printf "bye\\n"',
          );

          const winner = await Promise.race([
            readFirstChunk(child.stdout).then(() => 'chunk' as const),
            child.exit.then(() => 'exit' as const),
          ]);
          assert.strictEqual(
            winner,
            'chunk',
            'first stdout chunk must arrive before exit through createBashTool',
          );

          const rest = await readAllText(child.stdout);
          const info = await child.exit;
          assert.match(rest, /bye/);
          assert.strictEqual(info.success, true);
        } finally {
          await backend.dispose();
        }
      });
    },
  );
});
