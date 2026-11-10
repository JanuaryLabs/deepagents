import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  type FileChange,
  MICROSANDBOX_DEFAULT_DESTINATION,
  MicrosandboxSandboxError,
  createBashTool,
  createMicrosandboxSandbox,
  withStraceFileChanges,
} from '@deepagents/context';

type MicrosandboxSdk = typeof import('microsandbox');

const execFileAsync = promisify(execFile);

async function importMicrosandboxSdk(): Promise<MicrosandboxSdk | undefined> {
  try {
    return await import('microsandbox');
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

  const sdkInstalled = (await importMicrosandboxSdk()) !== undefined;
  describe('runtime availability', { skip: !sdkInstalled }, () => {
    // The SDK keeps the runtime it resolved for its first VM, and the
    // usability probe above has already booted one in this process, so the
    // broken runtime is configured on a fresh process from its start.
    it('rejects with MicrosandboxNotAvailableError when the runtime is incomplete', async () => {
      const program = `
        const { createMicrosandboxSandbox, MicrosandboxNotAvailableError } = await import('@deepagents/context');
        const { MicrosandboxError } = await import('microsandbox');
        try {
          await using sandbox = await createMicrosandboxSandbox();
          console.log(JSON.stringify({ created: true }));
        } catch (error) {
          console.log(JSON.stringify({
            name: error.name,
            notAvailable: error instanceof MicrosandboxNotAvailableError,
            sdkCause: error.cause instanceof MicrosandboxError,
          }));
        }
      `;

      const { stdout } = await execFileAsync(
        process.execPath,
        ['--no-warnings', '--input-type=module', '--eval', program],
        {
          cwd: import.meta.dirname,
          env: {
            ...process.env,
            MSB_PATH: `/deepagents-missing-runtime/${randomUUID()}/msb`,
          },
        },
      );

      assert.deepStrictEqual(JSON.parse(stdout), {
        name: 'MicrosandboxNotAvailableError',
        notAvailable: true,
        sdkCause: true,
      });
    });
  });

  describe('createMicrosandboxSandbox', { skip: !usable }, () => {
    describe('command execution', () => {
      it('captures stdout and preserves exit code on success', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const result = await sandbox.run({ command: 'printf "hello"' });
        assert.deepStrictEqual(result, {
          stdout: 'hello',
          stderr: '',
          exitCode: 0,
        });
      });

      it('preserves non-zero exit codes and stderr', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const result = await sandbox.run({
          command: 'echo "expected failure" >&2; exit 42',
        });
        assert.strictEqual(result.exitCode, 42);
        assert.match(result.stderr, /expected failure/);
      });

      it('rejects with the abort reason without waiting for the command', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const controller = new AbortController();
        const reason = new Error('stop');
        const pending = Promise.resolve(
          sandbox.run({ command: 'sleep 30', abortSignal: controller.signal }),
        );
        controller.abort(reason);
        const started = Date.now();
        await assert.rejects(pending, (error) => error === reason);
        assert.ok(
          Date.now() - started < 25_000,
          'abort must kill the guest command instead of waiting it out',
        );
      });

      it('resolves exit code 124 when commandTimeout elapses', async () => {
        await using sandbox = await createMicrosandboxSandbox({
          commandTimeout: 1_000,
        });
        const result = await sandbox.run({ command: 'sleep 30' });
        assert.strictEqual(result.exitCode, 124);
        assert.match(result.stderr, /timed out/);
      });
    });

    describe('file operations', () => {
      it('writes and reads files round trip, creating nested parents', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        await sandbox.writeTextFile({
          path: '/workspace/a/b/c.txt',
          content: 'nested content',
        });
        await sandbox.writeTextFile({
          path: '/tmp/deepagents-msb-file.txt',
          content: 'flat content',
        });
        await sandbox.writeBinaryFile({
          path: '/tmp/deepagents-msb-buf.txt',
          content: Buffer.from('buffer content'),
        });
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/workspace/a/b/c.txt' }),
          'nested content',
        );
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/tmp/deepagents-msb-file.txt' }),
          'flat content',
        );
        assert.strictEqual(
          await sandbox.readTextFile({ path: '/tmp/deepagents-msb-buf.txt' }),
          'buffer content',
        );
      });

      it('reads raw bytes with the binary encoding', async () => {
        await using sandbox = await createMicrosandboxSandbox();

        const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);
        await sandbox.writeBinaryFile({
          path: '/workspace/blob.bin',
          content: bytes,
        });

        const content = await sandbox.readBinaryFile({
          path: '/workspace/blob.bin',
        });

        assert.deepStrictEqual(
          Array.from(content ?? []),
          [0x89, 0x50, 0x00, 0xff],
        );
      });

      it('reports whether a path exists', async () => {
        await using sandbox = await createMicrosandboxSandbox();

        await sandbox.writeTextFile({
          path: '/workspace/present.txt',
          content: 'x',
        });

        assert.deepStrictEqual(
          await sandbox.stat({ path: '/workspace/present.txt' }),
          { type: 'file', size: 1 },
        );
        assert.strictEqual(
          (await sandbox.stat({ path: '/workspace' }))?.type,
          'directory',
        );
        assert.strictEqual(
          await sandbox.stat({ path: '/workspace/missing.txt' }),
          null,
        );
      });

      it('creates parent directories for byte and stream writes', async () => {
        await using sandbox = await createMicrosandboxSandbox();

        await sandbox.writeBinaryFile({
          path: 'bytes/nested/a.bin',
          content: new Uint8Array([1, 2]),
        });
        await sandbox.writeFile({
          path: 'stream/nested/b.bin',
          content: ReadableStream.from([
            new Uint8Array([3]),
            new Uint8Array([4]),
          ]),
        });

        const { stdout } = await sandbox.run({
          command: 'od -An -tu1 bytes/nested/a.bin stream/nested/b.bin',
        });
        assert.deepStrictEqual(stdout.trim().split(/\s+/), [
          '1',
          '2',
          '3',
          '4',
        ]);
      });

      it('rejects a streamed read of a directory instead of hanging', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        await sandbox.writeTextFile({ path: 'dir/keep.txt', content: 'keep' });

        await assert.rejects(
          Promise.resolve(sandbox.readFile({ path: 'dir' })),
          /directory/,
        );
      });
    });

    describe('failure modes', () => {
      it('fails clearly when the image does not contain Bash', async () => {
        await assert.rejects(
          createMicrosandboxSandbox({
            configure: (builder) => builder.image('alpine'),
          }),
          /Bash is required to execute sandbox commands/,
        );
      });

      it('leaves no VM behind when Bash is missing', async () => {
        const sdk = await import('microsandbox');
        const run = randomUUID();
        const labelled = () =>
          sdk.Sandbox.listWith((list) => list.label('deepagents-test', run));
        {
          await using control = await createMicrosandboxSandbox({
            configure: (builder) => builder.label('deepagents-test', run),
          });
          await control.run({ command: 'true' });
          assert.strictEqual((await labelled()).sandboxes.length, 1);
        }

        await assert.rejects(
          createMicrosandboxSandbox({
            configure: (builder) =>
              builder.image('alpine').label('deepagents-test', run),
          }),
          /Bash is required/,
        );

        const { sandboxes } = await labelled();
        assert.deepStrictEqual(
          sandboxes.map((handle) => handle.name),
          [],
        );
      });

      it('wait rejects with the abort reason when aborted mid-stream', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const controller = new AbortController();
        const reason = new Error('stop');
        const child = await sandbox.spawn({
          command: 'printf "hi\\n"; sleep 30; printf "bye\\n"',
          abortSignal: controller.signal,
        });

        assert.match(await readFirstChunk(child.stdout), /hi/);

        const drained = streamText(child.stdout);
        controller.abort(reason);
        const aborted = Date.now();

        await assert.rejects(
          Promise.resolve(child.wait()),
          (error) => error === reason,
        );
        assert.doesNotMatch(await drained, /bye/);
        assert.ok(
          Date.now() - aborted < 25_000,
          'abort must kill the guest command instead of waiting it out',
        );
      });

      it('wait resolves with non-zero code on command failure', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const child = await sandbox.spawn({ command: 'exit 42' });
        await streamText(child.stdout);
        await streamText(child.stderr);
        assert.deepStrictEqual(await child.wait(), { exitCode: 42 });
      });

      it('stdout and stderr both close after the child exits', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const child = await sandbox.spawn({ command: 'echo hi; echo err >&2' });
        const [out, err, info] = await Promise.all([
          streamText(child.stdout),
          streamText(child.stderr),
          child.wait(),
        ]);
        assert.strictEqual(out.trim(), 'hi');
        assert.strictEqual(err.trim(), 'err');
        assert.deepStrictEqual(info, { exitCode: 0 });
      });
    });

    describe('live streaming', () => {
      it('delivers stdout bytes before the child exits', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const child = await sandbox.spawn({
          command: 'printf "hi\\n"; sleep 2; printf "bye\\n"',
        });

        const winner = await Promise.race([
          readFirstChunk(child.stdout).then(() => 'chunk' as const),
          Promise.resolve(child.wait()).then(() => 'exit' as const),
        ]);
        assert.strictEqual(
          winner,
          'chunk',
          'first stdout chunk must arrive before the child exits (proves live streaming)',
        );

        const rest = await streamText(child.stdout);
        const info = await child.wait();
        assert.match(rest, /bye/);
        assert.strictEqual(info.exitCode, 0);
      });

      it('streams stderr independently of stdout', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const child = await sandbox.spawn({
          command: 'echo "to stdout"; echo "to stderr" >&2; echo "also stdout"',
        });
        const [out, err] = await Promise.all([
          streamText(child.stdout),
          streamText(child.stderr),
          child.wait(),
        ]);
        assert.deepStrictEqual(out.trim().split('\n'), [
          'to stdout',
          'also stdout',
        ]);
        assert.strictEqual(err.trim(), 'to stderr');
      });
    });

    describe('spawn options', () => {
      it('forwards env into the child', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const child = await sandbox.spawn({
          command: 'printf "%s\\n" "$MY_VAR"',
          env: { MY_VAR: 'hello-from-host' },
        });
        const text = await streamText(child.stdout);
        const info = await child.wait();
        assert.strictEqual(text.trim(), 'hello-from-host');
        assert.strictEqual(info.exitCode, 0);
      });

      it('forwards the working directory into the child', async () => {
        await using sandbox = await createMicrosandboxSandbox();
        const cwd = '/tmp/deepagents-msb-cwd';
        const mkdir = await sandbox.run({ command: `mkdir -p ${cwd}` });
        assert.strictEqual(mkdir.exitCode, 0);

        const child = await sandbox.spawn({
          command: 'pwd',
          workingDirectory: cwd,
        });
        const text = await streamText(child.stdout);
        const info = await child.wait();
        assert.strictEqual(text.trim(), cwd);
        assert.strictEqual(info.exitCode, 0);
      });
    });

    describe('lifecycle', () => {
      it('keeps a detached named sandbox running across client disposal and restart', async () => {
        const sdk = await import('microsandbox');
        const name = `deepagents-test-${randomUUID()}`;
        const [first, peer] = await Promise.all([
          createMicrosandboxSandbox({
            name,
            configure: (builder) => builder.detached(true),
          }),
          createMicrosandboxSandbox({
            name,
            configure: (builder) => builder.detached(true),
          }),
        ]);

        try {
          await first.dispose();
          assert.strictEqual(
            (await peer.run({ command: 'printf alive' })).stdout,
            'alive',
          );

          await (await sdk.Sandbox.get(name)).stop();
          const resumed = await createMicrosandboxSandbox({
            name,
            configure: (builder) => builder.detached(true),
          });
          await resumed.dispose();

          assert.strictEqual((await sdk.Sandbox.get(name)).status, 'running');
        } finally {
          await first.dispose().catch(() => {});
          await peer.dispose().catch(() => {});
          const handle = await sdk.Sandbox.get(name).catch(() => undefined);
          if (handle) {
            await (await handle.connectOrStart()).destroy().catch(() => {});
          }
        }
      });

      it('reacquires a named sandbox for concurrent operations after its endpoint stops', async () => {
        const sdk = await import('microsandbox');
        const name = `deepagents-test-${randomUUID()}`;
        const sandbox = await createMicrosandboxSandbox({
          name,
          configure: (builder) => builder.detached(true),
        });

        try {
          await (await sdk.Sandbox.get(name)).stop();
          const [result] = await Promise.all([
            sandbox.run({ command: 'printf recovered' }),
            sandbox.writeTextFile({
              path: '/workspace/recovered.txt',
              content: 'still writable',
            }),
          ]);
          assert.deepStrictEqual(result, {
            stdout: 'recovered',
            stderr: '',
            exitCode: 0,
          });
          assert.strictEqual(
            await sandbox.readTextFile({ path: '/workspace/recovered.txt' }),
            'still writable',
          );

          await sandbox.dispose();
          assert.strictEqual((await sdk.Sandbox.get(name)).status, 'running');
        } finally {
          await sandbox.dispose().catch(() => {});
          const handle = await sdk.Sandbox.get(name).catch(() => undefined);
          if (handle) {
            await (await handle.connectOrStart()).destroy().catch(() => {});
          }
        }
      });

      it('resumes a named sandbox with rootfs state intact after dispose', async () => {
        const sdk = await import('microsandbox');
        const name = `deepagents-test-${randomUUID()}`;
        try {
          {
            await using first = await createMicrosandboxSandbox({ name });

            await first.writeTextFile({
              path: '/workspace/persisted.txt',
              content: 'still here',
            });
          }

          await using second = await createMicrosandboxSandbox({ name });

          assert.strictEqual(
            await second.readTextFile({ path: '/workspace/persisted.txt' }),
            'still here',
          );
        } finally {
          await sdk.Sandbox.remove(name).catch(() => {});
        }
      });

      it('removes an unnamed sandbox entirely on dispose', async () => {
        const sdk = await import('microsandbox');
        const run = randomUUID();
        const labelled = async () =>
          (
            await sdk.Sandbox.listWith((list) =>
              list.label('deepagents-test', run),
            )
          ).sandboxes.map((handle) => handle.name);

        const sandbox = await createMicrosandboxSandbox({
          configure: (builder) => builder.label('deepagents-test', run),
        });
        await sandbox.run({ command: 'true' });
        const whileOpen = await labelled();
        await sandbox.dispose();

        const leftovers = await labelled();
        assert.strictEqual(whileOpen.length, 1);
        assert.deepStrictEqual(leftovers, []);
      });
    });

    describe('configure', () => {
      it('keeps a named sandbox persistent when configure() marks it ephemeral', async () => {
        const sdk = await import('microsandbox');
        const name = `deepagents-test-${randomUUID()}`;
        const sandbox = await createMicrosandboxSandbox({
          name,
          configure: (builder) => builder.detached(true).ephemeral(true),
        });

        try {
          await sandbox.writeTextFile({
            path: '/workspace/persist.txt',
            content: 'survives the stop',
          });
          await (await sdk.Sandbox.get(name)).stop();
          assert.strictEqual(
            await sandbox.readTextFile({ path: '/workspace/persist.txt' }),
            'survives the stop',
          );
        } finally {
          await sandbox.dispose().catch(() => {});
          const handle = await sdk.Sandbox.get(name).catch(() => undefined);
          if (handle) {
            await (await handle.connectOrStart()).destroy().catch(() => {});
          }
        }
      });

      it('keeps commands and relative paths in its workdir when it resumes a sandbox created with another', async () => {
        const sdk = await import('microsandbox');
        const name = `deepagents-test-${randomUUID()}`;
        try {
          await (
            await createMicrosandboxSandbox({ name, workdir: '/srv/first' })
          ).dispose();
          await using second = await createMicrosandboxSandbox({
            name,
            workdir: '/srv/second',
          });

          await second.writeTextFile({ path: 'here.txt', content: 'here' });
          const result = await second.run({ command: 'pwd; cat here.txt' });

          assert.deepStrictEqual(result, {
            stdout: '/srv/second\nhere',
            stderr: '',
            exitCode: 0,
          });
        } finally {
          await sdk.Sandbox.remove(name).catch(() => {});
        }
      });

      it('applies the factory workdir after configure()', async () => {
        await using sandbox = await createMicrosandboxSandbox({
          workdir: '/workspace',
          configure: (builder) => builder.workdir('/tmp'),
        });
        const result = await sandbox.run({ command: 'pwd' });
        assert.deepStrictEqual(result, {
          stdout: '/workspace\n',
          stderr: '',
          exitCode: 0,
        });
      });
    });
  });

  describe('readiness', { skip: !usable }, () => {
    it('returns the sandbox once the readiness hook resolves', async () => {
      await using sandbox = await createMicrosandboxSandbox({
        readiness: async (booting) => {
          const marker = await booting.run({
            command: 'echo ok > /tmp/readiness-ran.txt',
          });
          assert.strictEqual(marker.exitCode, 0);
        },
      });
      assert.strictEqual(
        await sandbox.readTextFile({ path: '/tmp/readiness-ran.txt' }),
        'ok\n',
      );
    });

    it('disposes the sandbox and rethrows when the hook fails', async () => {
      const sdk = await import('microsandbox');
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
        await using backend = await createMicrosandboxSandbox();

        const agent = await createBashTool({
          sandbox: backend,
          workingDirectory: MICROSANDBOX_DEFAULT_DESTINATION,
        });
        assert.ok(
          agent.sandbox.spawn,
          'createBashTool must forward spawn from the backend',
        );

        const result = await agent.sandbox.run({
          command: `cd ${MICROSANDBOX_DEFAULT_DESTINATION} && pwd`,
        });
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(
          result.stdout.trim(),
          MICROSANDBOX_DEFAULT_DESTINATION,
        );
      });

      it('resolves uploads and relative writes against the directory commands start in', async () => {
        await using backend = await createMicrosandboxSandbox();
        const { tools } = await createBashTool({
          sandbox: backend,
          files: { 'uploaded.txt': 'from upload' },
        });
        assert.ok(tools.bash.execute);
        assert.ok(tools.writeFile.execute);

        await tools.writeFile.execute(
          { path: 'written.txt', content: ' and write' },
          {
            abortSignal: undefined,
            context: {},
            messages: [],
            toolCallId: 'relative-write',
          },
        );
        const result = await tools.bash.execute(
          {
            command: 'pwd; cat uploaded.txt written.txt',
            reasoning: 'read the files from the starting directory',
          },
          {
            abortSignal: undefined,
            context: {},
            messages: [],
            toolCallId: 'relative-read',
          },
        );

        assert.deepStrictEqual(result, {
          stdout: `${MICROSANDBOX_DEFAULT_DESTINATION}\nfrom upload and write`,
          stderr: '',
          exitCode: 0,
        });
      });

      it('executes Bash-only syntax through the public bash tool', async () => {
        await using backend = await createMicrosandboxSandbox();

        const { bash } = await createBashTool({
          sandbox: backend,
          workingDirectory: MICROSANDBOX_DEFAULT_DESTINATION,
        });
        const execute = bash.execute;
        assert.ok(execute);

        const result = await execute(
          {
            command: 'values=(one two); printf \'%s\\n\' "${values[1]}"',
            reasoning: 'verify the Bash execution contract',
          },
          {
            abortSignal: undefined,
            context: {},
            messages: [],
            toolCallId: 'bash-array-contract',
          },
        );

        assert.deepStrictEqual(result, {
          stdout: 'two\n',
          stderr: '',
          exitCode: 0,
        });

        assert.deepStrictEqual(
          await execute(
            {
              command: "printf '%s\\n' posix",
              reasoning: 'verify POSIX commands still run under Bash',
            },
            {
              abortSignal: undefined,
              context: {},
              messages: [],
              toolCallId: 'posix-command-contract',
            },
          ),
          { stdout: 'posix\n', stderr: '', exitCode: 0 },
        );
      });

      it('streams live stdout through the wrapper', async () => {
        await using backend = await createMicrosandboxSandbox();

        const agent = await createBashTool({
          sandbox: backend,
          workingDirectory: MICROSANDBOX_DEFAULT_DESTINATION,
        });
        assert.ok(agent.sandbox.spawn);
        const child = await agent.sandbox.spawn({
          command: 'printf "hi\\n"; sleep 2; printf "bye\\n"',
        });

        const winner = await Promise.race([
          readFirstChunk(child.stdout).then(() => 'chunk' as const),
          child.wait().then(() => 'exit' as const),
        ]);
        assert.strictEqual(
          winner,
          'chunk',
          'first stdout chunk must arrive before exit through createBashTool',
        );

        const rest = await streamText(child.stdout);
        const info = await child.wait();
        assert.match(rest, /bye/);
        assert.strictEqual(info.exitCode, 0);
      });
    },
  );

  describe('withStraceFileChanges', { skip: !usable }, () => {
    it('reports writes by a command and by the session', async () => {
      await using sandbox = await createMicrosandboxSandbox();
      const installed = await sandbox.run({
        command: 'apk add --no-cache strace',
      });
      assert.strictEqual(installed.exitCode, 0, installed.stderr);
      const seen: FileChange[] = [];
      const tracked = await withStraceFileChanges(sandbox, {
        include: [
          MICROSANDBOX_DEFAULT_DESTINATION,
          `${MICROSANDBOX_DEFAULT_DESTINATION}/**`,
        ],
        onFileChanges: (changes) => {
          seen.push(...changes);
        },
      });

      const result = await tracked.run({
        command: `echo traced > ${MICROSANDBOX_DEFAULT_DESTINATION}/traced.txt`,
      });
      await tracked.writeTextFile({
        path: `${MICROSANDBOX_DEFAULT_DESTINATION}/written.txt`,
        content: 'written',
      });

      assert.strictEqual(result.exitCode, 0, result.stderr);
      assert.deepStrictEqual(
        seen.map(({ op, path }) => ({ op, path })),
        [
          {
            op: 'write',
            path: `${MICROSANDBOX_DEFAULT_DESTINATION}/traced.txt`,
          },
          {
            op: 'write',
            path: `${MICROSANDBOX_DEFAULT_DESTINATION}/written.txt`,
          },
        ],
      );
    });
  });
});
