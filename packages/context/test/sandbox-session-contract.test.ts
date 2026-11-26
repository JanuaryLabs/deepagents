import { experimental_createBashTool } from '@ai-sdk/tool-bash';
import { describe, it } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { InMemoryFs } from 'just-bash';
import spawn, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { text } from 'node:stream/consumers';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type DisposableSandbox,
  MicrosandboxSandboxError,
  createAppleContainerSandbox,
  createDaytonaSandbox,
  createDockerSandbox,
  createMicrosandboxSandbox,
  createVirtualSandbox,
} from '@deepagents/context';

import { appleContainerUnavailable } from './helpers/apple-container.ts';

const testbed = new DockerTestbed({ environment: process.env });
const dockerDefaults = { container: await testbed.defaults() };

interface Backend {
  name: string;
  /** Says why this host cannot run the backend, or `undefined` when it can. */
  unavailable?: () => Promise<string | undefined>;
  writableStdin: boolean;
  /**
   * What `run` does on abort. The official virtual adapter resolves with exit
   * 124; the session contract only says that `wait()` rejects.
   */
  runAbort: 'rejects' | 'resolves';
  /**
   * What stderr does after a reader cancels stdout. The official just-bash
   * adapter, like the AI SDK's Vercel adapter, errors its other stream when it
   * next enqueues into the canceled one; the process and its exit still end
   * normally.
   */
  stderrAfterStdoutCancel: 'flows' | 'errors';
  /**
   * What a write to a symbolic link does. Like Node's fs.writeFile and shell
   * redirection, a session writes through it to its target. just-bash's
   * InMemoryFs.writeFile replaces the link with a file.
   */
  linkWrite: 'through' | 'replaces';
  open: () => Promise<DisposableSandbox>;
  /** How a test finds a sandbox in its engine. Absent when a backend holds nothing. */
  engine?: {
    /** The name the engine holds the sandbox under, read from the live sandbox. */
    nameOf: (sandbox: DisposableSandbox) => Promise<string>;
    /** Whether the engine holds the named sandbox. */
    holds: (sandboxName: string) => Promise<boolean>;
  };
}

/**
 * Whether the runtime can boot a VM here (KVM access on a Linux runner, a
 * catalog that this msb can read) shows only when it boots one, so the probe
 * boots one. A failure the package or the runtime reports skips the backend;
 * any other error fails it.
 */
async function microsandboxUnavailable(): Promise<string | undefined> {
  const { MicrosandboxError } = await import('microsandbox');
  try {
    await (await createMicrosandboxSandbox()).dispose();
    return undefined;
  } catch (error) {
    if (
      error instanceof MicrosandboxSandboxError ||
      error instanceof MicrosandboxError
    ) {
      return error.message;
    }
    throw error;
  }
}

const DAYTONA_PROBE_MS = 15_000;

async function daytonaClient() {
  const { Daytona } = await import('@daytona/sdk');
  return new Daytona().v2;
}

/**
 * A key and a reachable API: one sandbox list, bounded so that an unreachable
 * API skips the backend instead of hanging the suite.
 */
async function daytonaUnavailable(): Promise<string | undefined> {
  if (!process.env.DAYTONA_API_KEY) return 'DAYTONA_API_KEY is not set';
  const client = await daytonaClient();
  const deadline = AbortSignal.timeout(DAYTONA_PROBE_MS);
  try {
    await Promise.race([
      client.list({ limit: 1 }),
      new Promise<never>((_, reject) => {
        deadline.addEventListener('abort', () => reject(deadline.reason), {
          once: true,
        });
      }),
    ]);
    return undefined;
  } catch (error) {
    if (deadline.aborted) {
      return `the Daytona API did not answer within ${DAYTONA_PROBE_MS / 1000} s`;
    }
    throw error;
  }
}

const backends: Backend[] = [
  {
    name: 'virtual',
    writableStdin: false,
    runAbort: 'resolves',
    stderrAfterStdoutCancel: 'errors',
    linkWrite: 'replaces',
    open: () => createVirtualSandbox({ fs: new InMemoryFs() }),
  },
  {
    name: 'docker',
    writableStdin: true,
    runAbort: 'rejects',
    stderrAfterStdoutCancel: 'flows',
    linkWrite: 'through',
    open: () => createDockerSandbox(dockerDefaults),
    engine: {
      // A container's hostname is the start of its id, which the engine finds it by.
      nameOf: hostname,
      holds: async (name) => {
        const client = await testbed.client();
        return (await client.containers.find(name)) !== undefined;
      },
    },
  },
  {
    name: 'apple',
    unavailable: appleContainerUnavailable,
    writableStdin: true,
    runAbort: 'rejects',
    stderrAfterStdoutCancel: 'flows',
    linkWrite: 'through',
    open: () => createAppleContainerSandbox(),
    engine: {
      // The CLI makes a container's hostname its name.
      nameOf: hostname,
      holds: async (name) => {
        try {
          const { stdout } = await spawn('container', ['inspect', name]);
          const entries: unknown = JSON.parse(stdout.trim() || '[]');
          return Array.isArray(entries) && entries.length > 0;
        } catch (error) {
          if (
            error instanceof SubprocessError &&
            /not found/.test(error.stderr)
          ) {
            return false;
          }
          throw error;
        }
      },
    },
  },
  {
    name: 'microsandbox',
    unavailable: microsandboxUnavailable,
    writableStdin: true,
    runAbort: 'rejects',
    stderrAfterStdoutCancel: 'flows',
    linkWrite: 'through',
    open: () => createMicrosandboxSandbox(),
    engine: {
      // A VM's hostname is its name.
      nameOf: hostname,
      holds: async (name) => {
        const { Sandbox, SandboxNotFoundError: Gone } =
          await import('microsandbox');
        try {
          await Sandbox.get(name);
          return true;
        } catch (error) {
          if (error instanceof Gone) return false;
          throw error;
        }
      },
    },
  },
  {
    name: 'daytona',
    unavailable: daytonaUnavailable,
    writableStdin: true,
    runAbort: 'rejects',
    stderrAfterStdoutCancel: 'flows',
    linkWrite: 'through',
    open: async () => createDaytonaSandbox(await daytonaClient()),
    engine: {
      // Daytona gives each sandbox its id; `get` reads it at once, where
      // search lags.
      nameOf: async (sandbox) => {
        const { stdout } = await sandbox.run({
          command: 'printf %s "$DAYTONA_SANDBOX_ID"',
        });
        assert.ok(stdout, 'the sandbox knows its id');
        return stdout;
      },
      holds: async (id) => {
        const sandbox = await (await daytonaClient()).get(id);
        return sandbox.state === 'started';
      },
    },
  },
];

async function hostname(sandbox: DisposableSandbox): Promise<string> {
  const name = (await sandbox.readTextFile({ path: '/etc/hostname' }))?.trim();
  assert.ok(name, 'the sandbox has a hostname');
  return name;
}

const LATER_WRITE_DELAY_MS = 3_500;
/** Long enough for a stop to land on a remote engine, where one exec takes seconds. */
const STOPPABLE_COMMAND =
  'echo started > started.txt; sleep 10; echo late > late.txt';
const STOP_WINDOW_MS = 10_500;

function waitForStarted(sandbox: DisposableSandbox, signal: AbortSignal) {
  return waitFor(
    async () =>
      assert.equal(
        await sandbox.readTextFile({ path: 'started.txt' }),
        'started\n',
      ),
    { signal },
  );
}

void describe.each(
  backends,
  ({
    name,
    unavailable,
    open,
    writableStdin,
    runAbort,
    stderrAfterStdoutCancel,
    linkWrite,
    engine,
  }) =>
    describe(`sandbox session contract: ${name}`, async () => {
      const skip = await unavailable?.();
      describe('failure modes', { skip }, () => {
        it(`stops a running command and ${runAbort === 'rejects' ? 'rejects with the abort reason' : 'resolves with exit 124'} when run is aborted`, async (t: TestContext) => {
          await using sandbox = await open();
          const controller = new AbortController();
          const reason = new Error('stop');

          const running = Promise.resolve(
            sandbox.run({
              command: STOPPABLE_COMMAND,
              abortSignal: controller.signal,
            }),
          );
          await waitForStarted(sandbox, t.signal);
          controller.abort(reason);
          if (runAbort === 'rejects') {
            await assert.rejects(running, (error) => error === reason);
          } else {
            assert.equal((await running).exitCode, 124);
          }
          await sleep(STOP_WINDOW_MS);

          assert.equal(await sandbox.readTextFile({ path: 'late.txt' }), null);
        });

        it('rejects wait with the abort reason and stops the process when spawn is aborted', async (t: TestContext) => {
          await using sandbox = await open();
          const controller = new AbortController();
          const reason = new Error('stop');
          const child = await sandbox.spawn({
            command: STOPPABLE_COMMAND,
            abortSignal: controller.signal,
          });
          await waitForStarted(sandbox, t.signal);

          controller.abort(reason);

          await assert.rejects(
            Promise.resolve(child.wait()),
            (error) => error === reason,
          );
          await sleep(STOP_WINDOW_MS);
          assert.equal(await sandbox.readTextFile({ path: 'late.txt' }), null);
        });

        it('stops the process on kill and tolerates a second kill', async (t: TestContext) => {
          await using sandbox = await open();
          const child = await sandbox.spawn({ command: STOPPABLE_COMMAND });
          await waitForStarted(sandbox, t.signal);

          await child.kill();
          await child.kill();
          await sleep(STOP_WINDOW_MS);

          assert.equal(await sandbox.readTextFile({ path: 'late.txt' }), null);
        });

        it('lets wait settle after kill, and tolerates a kill after the exit', async () => {
          await using sandbox = await open();
          const killed = await sandbox.spawn({ command: 'sleep 30' });
          const finished = await sandbox.spawn({ command: 'exit 5' });

          await killed.kill();
          const afterKill = await killed.wait();
          const afterExit = await finished.wait();
          await finished.kill();

          assert.notEqual(afterKill.exitCode, 0);
          assert.deepEqual(afterExit, { exitCode: 5 });
        });

        it('never starts a command when the signal is already aborted', async () => {
          await using sandbox = await open();
          const reason = new Error('stop');
          const command = 'echo started > started.txt';

          await assert.rejects(
            Promise.resolve(
              sandbox.run({ command, abortSignal: AbortSignal.abort(reason) }),
            ),
            (error) => error === reason,
          );
          await assert.rejects(
            Promise.resolve(
              sandbox.spawn({
                command,
                abortSignal: AbortSignal.abort(reason),
              }),
            ),
            (error) => error === reason,
          );
          await sleep(LATER_WRITE_DELAY_MS);

          assert.equal(
            await sandbox.readTextFile({ path: 'started.txt' }),
            null,
          );
        });

        void it.each(
          [
            {
              method: 'readFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.readFile({ path, abortSignal }),
            },
            {
              method: 'readBinaryFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.readBinaryFile({ path, abortSignal }),
            },
            {
              method: 'readTextFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.readTextFile({ path, abortSignal }),
            },
            {
              method: 'writeTextFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.writeTextFile({ path, content: 'x', abortSignal }),
            },
            {
              method: 'writeBinaryFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) =>
                sandbox.writeBinaryFile({
                  path,
                  content: new Uint8Array([1]),
                  abortSignal,
                }),
            },
            {
              method: 'writeFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) =>
                sandbox.writeFile({
                  path,
                  content: ReadableStream.from([new Uint8Array([1])]),
                  abortSignal,
                }),
            },
            {
              method: 'stat',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.stat({ path, abortSignal }),
            },
            {
              method: 'listDirectory',
              call: (
                sandbox: DisposableSandbox,
                _path: string,
                abortSignal: AbortSignal,
              ) => sandbox.listDirectory({ path: '.', abortSignal }),
            },
            {
              method: 'deleteFile',
              call: (
                sandbox: DisposableSandbox,
                path: string,
                abortSignal: AbortSignal,
              ) => sandbox.deleteFile({ path, abortSignal }),
            },
          ],
          ({ method, call }) =>
            it(`rejects a ${method} call whose signal is already aborted`, async () => {
              await using sandbox = await open();
              await sandbox.writeTextFile({
                path: 'file.txt',
                content: 'keep',
              });
              const reason = new Error('stop');
              const abortSignal = AbortSignal.abort(reason);
              const path = 'file.txt';

              await assert.rejects(
                Promise.resolve(call(sandbox, path, abortSignal)),
                (error) => error === reason,
              );

              assert.equal(await sandbox.readTextFile({ path }), 'keep');
            }),
        );

        it('resolves every read of a missing file to null', async () => {
          await using sandbox = await open();

          assert.equal(await sandbox.readFile({ path: 'missing.txt' }), null);
          assert.equal(
            await sandbox.readBinaryFile({ path: 'missing.txt' }),
            null,
          );
          assert.equal(
            await sandbox.readTextFile({ path: 'missing.txt' }),
            null,
          );
        });

        it('reports a path under a file as missing', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({ path: 'file.txt', content: 'x' });
          const path = 'file.txt/under';

          assert.equal(await sandbox.readBinaryFile({ path }), null);
          assert.equal(await sandbox.stat({ path }), null);
          assert.equal(await sandbox.listDirectory({ path }), null);
          assert.equal(await sandbox.deleteFile({ path }), false);
        });

        it('rejects a read of a directory', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: 'dir/keep.txt',
            content: 'keep',
          });

          await assert.rejects(
            Promise.resolve(sandbox.readBinaryFile({ path: 'dir' })),
            /directory/i,
          );
        });

        it('rejects a write onto a directory and keeps its contents', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: 'dir/keep.txt',
            content: 'keep',
          });

          await assert.rejects(
            Promise.resolve(
              sandbox.writeTextFile({ path: 'dir', content: 'boom' }),
            ),
            /directory/i,
          );
          await assert.rejects(
            Promise.resolve(
              sandbox.writeBinaryFile({
                path: 'dir',
                content: new Uint8Array([1]),
              }),
            ),
            /directory/i,
          );
          await assert.rejects(
            Promise.resolve(
              sandbox.writeFile({
                path: 'dir',
                content: ReadableStream.from([new Uint8Array([1])]),
              }),
            ),
            /directory/i,
          );

          assert.equal(
            await sandbox.readTextFile({ path: 'dir/keep.txt' }),
            'keep',
          );
        });

        it('rejects deleting a directory, reports a missing file as false, and deletes a link without its target', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: 'dir/keep.txt',
            content: 'keep',
          });
          await sandbox.writeTextFile({
            path: 'target.txt',
            content: 'target',
          });
          await sandbox.run({ command: 'ln -s target.txt link.txt' });

          await assert.rejects(
            Promise.resolve(sandbox.deleteFile({ path: 'dir' })),
            /directory/i,
          );
          const missing = await sandbox.deleteFile({ path: 'missing.txt' });
          const link = await sandbox.deleteFile({ path: 'link.txt' });

          assert.equal(
            await sandbox.readTextFile({ path: 'dir/keep.txt' }),
            'keep',
          );
          assert.equal(missing, false);
          assert.equal(link, true);
          assert.equal(await sandbox.stat({ path: 'link.txt' }), null);
          assert.equal(
            await sandbox.readTextFile({ path: 'target.txt' }),
            'target',
          );
        });

        it('lists a missing directory as null and rejects listing a file', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({ path: 'file.txt', content: 'x' });

          assert.equal(await sandbox.listDirectory({ path: 'missing' }), null);
          await assert.rejects(
            Promise.resolve(sandbox.listDirectory({ path: 'file.txt' })),
            /directory/i,
          );
        });

        it('returns a failing command as a result with its exact output', async () => {
          await using sandbox = await open();

          const { exitCode, stdout, stderr } = await sandbox.run({
            command: 'echo out; echo err >&2; exit 3',
          });

          assert.deepEqual(
            { exitCode, stdout, stderr },
            { exitCode: 3, stdout: 'out\n', stderr: 'err\n' },
          );
        });

        if (writableStdin) {
          it('feeds stdin to the process and delivers EOF when it closes', async () => {
            await using sandbox = await open();

            const child = await sandbox.spawn({
              command: 'cat; echo end',
              stdin: true,
            });
            const stdout = text(child.stdout);
            const writer = child.stdin.getWriter();
            await writer.write(new TextEncoder().encode('fed'));
            await writer.close();

            assert.equal(await stdout, 'fedend\n');
            assert.deepEqual(await child.wait(), { exitCode: 0 });
          });

          it('closes standard input when stdin is not requested', async () => {
            await using sandbox = await open();

            const child = await sandbox.spawn({ command: 'cat; echo end' });

            assert.equal(await text(child.stdout), 'end\n');
            assert.equal('stdin' in child, false);
          });
        } else {
          it('rejects writable stdin before the command starts', async () => {
            await using sandbox = await open();

            await assert.rejects(
              Promise.resolve(
                sandbox.spawn({
                  command: 'echo started > started.txt',
                  stdin: true,
                }),
              ),
              /stdin/i,
            );
            await sleep(LATER_WRITE_DELAY_MS);

            assert.equal(
              await sandbox.readTextFile({ path: 'started.txt' }),
              null,
            );
          });
        }
      });

      describe('commands', { skip }, () => {
        it('does not carry cd into the next command or relative file paths', async () => {
          await using sandbox = await open();
          const before = await sandbox.run({ command: 'pwd' });

          await sandbox.run({ command: 'cd /tmp' });
          await sandbox.writeTextFile({ path: 'here.txt', content: 'here' });

          const after = await sandbox.run({ command: 'pwd; cat here.txt' });
          assert.equal(after.stdout, `${before.stdout}here`);
        });

        it('resolves relative paths in file calls and workingDirectory against one base', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({ path: 'rel/a.txt', content: 'a' });
          const { stdout: base } = await sandbox.run({ command: 'pwd' });

          const fromBase = await sandbox.run({ command: 'cat rel/a.txt' });
          const fromRelative = await sandbox.run({
            command: 'pwd; cat a.txt',
            workingDirectory: 'rel',
          });

          assert.equal(fromBase.stdout, 'a');
          assert.equal(fromRelative.stdout, `${base.trimEnd()}/rel\na`);
        });

        it('runs a command in an absolute workingDirectory', async () => {
          await using sandbox = await open();

          const { stdout } = await sandbox.run({
            command: 'pwd',
            workingDirectory: '/tmp',
          });

          assert.equal(stdout, '/tmp\n');
        });

        it('applies per-call env without leaking it into the next command', async () => {
          await using sandbox = await open();

          const set = await sandbox.run({
            command: 'echo "[$CONTRACT_VALUE]"',
            env: { CONTRACT_VALUE: 'secret' },
          });
          const next = await sandbox.run({
            command: 'echo "[$CONTRACT_VALUE]"',
          });

          assert.equal(set.stdout, '[secret]\n');
          assert.equal(next.stdout, '[]\n');
        });

        it('streams stdout and stderr from spawn and reports the exit code', async () => {
          await using sandbox = await open();

          const child = await sandbox.spawn({
            command: 'echo out; echo err >&2; exit 4',
          });
          const [stdout, stderr, exit] = await Promise.all([
            text(child.stdout),
            text(child.stderr),
            child.wait(),
          ]);

          assert.deepEqual(
            { stdout, stderr, exit },
            { stdout: 'out\n', stderr: 'err\n', exit: { exitCode: 4 } },
          );
        });

        it(`keeps the process ${stderrAfterStdoutCancel === 'flows' ? 'and its stderr ' : ''}when a reader cancels stdout`, async () => {
          await using sandbox = await open();

          const child = await sandbox.spawn({
            command: 'echo first; sleep 1; echo second; echo err >&2; exit 3',
          });
          const reader = child.stdout.getReader();
          await reader.read();
          await reader.cancel(new Error('caller stopped reading'));

          if (stderrAfterStdoutCancel === 'flows') {
            assert.equal(await text(child.stderr), 'err\n');
          }
          assert.deepEqual(await child.wait(), { exitCode: 3 });
        });
      });

      describe('files', { skip }, () => {
        it('reads 1-based inclusive line ranges and stops at end of file', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: 'lines.txt',
            content: 'a\nb\nc\n',
          });

          assert.equal(
            await sandbox.readTextFile({
              path: 'lines.txt',
              startLine: 2,
              endLine: 2,
            }),
            'b',
          );
          assert.equal(
            await sandbox.readTextFile({
              path: 'lines.txt',
              startLine: 3,
              endLine: 99,
            }),
            'c\n',
          );
          assert.equal(
            await sandbox.readTextFile({ path: 'lines.txt', startLine: 2 }),
            'b\nc\n',
          );
          assert.equal(
            await sandbox.readTextFile({ path: 'lines.txt', endLine: 2 }),
            'a\nb',
          );
        });

        it('round-trips bytes that are not valid UTF-8 through binary and stream calls', async () => {
          await using sandbox = await open();
          const bytes = [0xff, 0x00, 0xfe];

          await sandbox.writeBinaryFile({
            path: 'binary.bin',
            content: new Uint8Array(bytes),
          });
          await sandbox.writeFile({
            path: 'stream.bin',
            content: ReadableStream.from([
              new Uint8Array([0xff, 0x00]),
              new Uint8Array([0xfe]),
            ]),
          });

          const binary = await sandbox.readBinaryFile({ path: 'binary.bin' });
          const stream = await sandbox.readFile({ path: 'stream.bin' });
          assert.ok(stream);
          const chunks = await Array.fromAsync(stream);
          assert.deepEqual([...(binary ?? [])], bytes);
          assert.deepEqual(
            chunks.flatMap((chunk) => [...chunk]),
            bytes,
          );
        });

        it('round-trips text, creates parent directories, and replaces on rewrite', async () => {
          await using sandbox = await open();

          await sandbox.writeTextFile({
            path: 'a/b/c.txt',
            content: 'héllo, a much longer first version',
          });
          await sandbox.writeTextFile({ path: 'a/b/c.txt', content: 'héllo' });

          assert.equal(
            await sandbox.readTextFile({ path: 'a/b/c.txt' }),
            'héllo',
          );
        });

        it('creates parent directories for binary and stream writes', async () => {
          await using sandbox = await open();

          await sandbox.writeBinaryFile({
            path: 'binary/deep/bytes.bin',
            content: new Uint8Array([0, 255]),
          });
          await sandbox.writeFile({
            path: 'stream/deep/text.txt',
            content: ReadableStream.from([
              new TextEncoder().encode('streamed'),
            ]),
          });

          const bytes = await sandbox.readBinaryFile({
            path: 'binary/deep/bytes.bin',
          });
          assert.deepEqual([...(bytes ?? [])], [0, 255]);
          assert.equal(
            await sandbox.readTextFile({ path: 'stream/deep/text.txt' }),
            'streamed',
          );
        });

        it('encodes and decodes text with the requested encoding', async () => {
          await using sandbox = await open();

          await sandbox.writeTextFile({
            path: 'latin.txt',
            content: 'é',
            encoding: 'latin1',
          });

          const bytes = await sandbox.readBinaryFile({ path: 'latin.txt' });
          assert.deepEqual([...(bytes ?? [])], [0xe9]);
          assert.equal(
            await sandbox.readTextFile({
              path: 'latin.txt',
              encoding: 'latin1',
            }),
            'é',
          );
        });

        it('stats type and byte size, follows links, and reports missing paths as null', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: 'dir/multibyte.txt',
            content: 'é',
          });
          await sandbox.run({
            command: 'ln -s dir/multibyte.txt file-link; ln -s dir dir-link',
          });

          const file = await sandbox.stat({ path: 'dir/multibyte.txt' });
          const directory = await sandbox.stat({ path: 'dir' });
          const fileLink = await sandbox.stat({ path: 'file-link' });
          const directoryLink = await sandbox.stat({ path: 'dir-link' });

          assert.deepEqual(file, { type: 'file', size: 2 });
          assert.equal(directory?.type, 'directory');
          assert.deepEqual(fileLink, { type: 'file', size: 2 });
          assert.equal(directoryLink?.type, 'directory');
          assert.equal(await sandbox.stat({ path: 'missing' }), null);
        });

        it(`${linkWrite === 'through' ? 'writes through a link to its target and creates the target of a dangling link' : 'replaces a link with a file on write'}`, async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({ path: 'target.txt', content: 'old' });
          await sandbox.run({
            command:
              'ln -s target.txt link.txt; ln -s created.txt dangling.txt',
          });

          await sandbox.writeTextFile({ path: 'link.txt', content: 'new' });
          await sandbox.writeTextFile({
            path: 'dangling.txt',
            content: 'made',
          });

          const entries = await sandbox.listDirectory({ path: '.' });
          const files = entries
            ?.filter((entry) => entry.name.endsWith('.txt'))
            .toSorted((a, b) => a.name.localeCompare(b.name));
          if (linkWrite === 'through') {
            assert.equal(
              await sandbox.readTextFile({ path: 'target.txt' }),
              'new',
            );
            assert.equal(
              await sandbox.readTextFile({ path: 'created.txt' }),
              'made',
            );
            assert.deepEqual(files, [
              { name: 'created.txt', type: 'file' },
              { name: 'dangling.txt', type: 'symlink' },
              { name: 'link.txt', type: 'symlink' },
              { name: 'target.txt', type: 'file' },
            ]);
          } else {
            assert.equal(
              await sandbox.readTextFile({ path: 'target.txt' }),
              'old',
            );
            assert.deepEqual(files, [
              { name: 'dangling.txt', type: 'file' },
              { name: 'link.txt', type: 'file' },
              { name: 'target.txt', type: 'file' },
            ]);
          }
        });

        it('lists one directory level with entry types, reporting links as links', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({ path: 'top/file.txt', content: 'x' });
          await sandbox.writeTextFile({
            path: 'top/sub/deep.txt',
            content: 'x',
          });
          await sandbox.run({ command: 'ln -s file.txt top/link' });

          const entries = await sandbox.listDirectory({ path: 'top' });

          assert.deepEqual(
            entries?.toSorted((a, b) => a.name.localeCompare(b.name)),
            [
              { name: 'file.txt', type: 'file' },
              { name: 'link', type: 'symlink' },
              { name: 'sub', type: 'directory' },
            ],
          );
        });
      });

      describe('official tool and lifecycle', { skip }, () => {
        it('lets the official bash tool run a real command through the session', async () => {
          await using sandbox = await open();
          await sandbox.writeTextFile({
            path: '/tmp/official/notes.txt',
            content: 'from the session',
          });

          const bash = await experimental_createBashTool({
            sandbox,
            workingDirectory: '/tmp/official',
          });
          const result = await bash.execute(
            { command: 'pwd; cat notes.txt; echo written > out.txt' },
            { toolCallId: 'call-1', messages: [], context: {} },
          );

          assert.deepEqual(result, {
            stdout: '/tmp/official\nfrom the session',
            stderr: '',
            exitCode: 0,
          });
          assert.equal(
            await sandbox.readTextFile({ path: '/tmp/official/out.txt' }),
            'written\n',
          );
          assert.ok(sandbox.description.length > 0);
          assert.ok(String(bash.description).includes(sandbox.description));
        });

        it('tolerates repeated disposal through both dispose paths', async () => {
          const sandbox = await open();

          await sandbox.dispose();
          await sandbox[Symbol.asyncDispose]();
          await sandbox.dispose();
        });

        if (engine) {
          it('releases what the engine holds by the time dispose resolves', async () => {
            await using sandbox = await open();
            const sandboxName = await engine.nameOf(sandbox);
            const heldWhileOpen = await engine.holds(sandboxName);

            await sandbox.dispose();

            assert.equal(heldWhileOpen, true);
            assert.equal(await engine.holds(sandboxName), false);
          });
        }
      });
    }),
);
