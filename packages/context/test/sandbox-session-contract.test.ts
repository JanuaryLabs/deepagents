import { experimental_createBashTool } from '@ai-sdk/tool-bash';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { InMemoryFs } from 'just-bash';
import spawn, { SubprocessError } from 'nano-spawn';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { type TestContext, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type DisposableSandbox,
  appleEngine,
  createAppleContainerSandbox,
  createDockerSandbox,
  createVirtualSandbox,
} from '@deepagents/context';

import { dockerSandboxDefaults } from './helpers/docker-sandbox-defaults.ts';

const testbed = new DockerTestbed({ environment: process.env });
const dockerDefaults = dockerSandboxDefaults(testbed.defaults);

interface Backend {
  name: string;
  /** Why this host cannot run the backend. */
  skip?: string;
  writableStdin: boolean;
  open: (sandboxName?: string) => Promise<DisposableSandbox>;
  /** Whether the engine holds the named sandbox. Absent when a backend holds nothing. */
  holds?: (sandboxName: string) => Promise<boolean>;
}

async function appleContainerUnavailable(): Promise<string | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return 'Apple containers need Apple silicon';
  }
  try {
    await spawn('container', ['system', 'status']);
    return undefined;
  } catch {
    return 'the Apple `container` service is not running';
  }
}

const backends: Backend[] = [
  {
    name: 'virtual',
    writableStdin: false,
    open: () => createVirtualSandbox({ fs: new InMemoryFs() }),
  },
  {
    name: 'docker',
    writableStdin: true,
    open: (name) => createDockerSandbox({ ...dockerDefaults, name }),
    holds: async (name) => {
      const client = await testbed.client();
      return (await client.containers.find(`sandbox-${name}`)) !== undefined;
    },
  },
  {
    name: 'apple',
    skip: await appleContainerUnavailable(),
    writableStdin: true,
    open: (name) => createAppleContainerSandbox({ name }),
    holds: async (name) => {
      try {
        const { stdout } = await spawn('container', [
          'inspect',
          `sandbox-${name}`,
        ]);
        return appleEngine.parseStatus(stdout) !== 'absent';
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
];

const STARTED = { interval: 50, timeout: 30_000 };
const LATER_WRITE_DELAY_MS = 3_500;
/** Long enough for a stop to land on a remote engine, where one exec takes seconds. */
const STOPPABLE_COMMAND =
  'echo started > started.txt; sleep 10; echo late > late.txt';
const STOP_WINDOW_MS = 10_500;

for (const { name, skip, open, writableStdin, holds } of backends) {
  describe(`sandbox session contract: ${name}`, { skip }, () => {
    describe('failure modes', () => {
      it('stops a running command when run is aborted', async (t: TestContext) => {
        await using sandbox = await open();
        const controller = new AbortController();

        const running = Promise.resolve(
          sandbox.run({
            command: STOPPABLE_COMMAND,
            abortSignal: controller.signal,
          }),
        ).catch(() => undefined);
        await t.waitFor(
          async () =>
            assert.equal(
              await sandbox.readTextFile({ path: 'started.txt' }),
              'started\n',
            ),
          STARTED,
        );
        controller.abort(new Error('stop'));
        await running;
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
        await t.waitFor(
          async () =>
            assert.equal(
              await sandbox.readTextFile({ path: 'started.txt' }),
              'started\n',
            ),
          STARTED,
        );

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
        await t.waitFor(
          async () =>
            assert.equal(
              await sandbox.readTextFile({ path: 'started.txt' }),
              'started\n',
            ),
          STARTED,
        );

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
            sandbox.spawn({ command, abortSignal: AbortSignal.abort(reason) }),
          ),
          (error) => error === reason,
        );
        await sleep(LATER_WRITE_DELAY_MS);

        assert.equal(await sandbox.readTextFile({ path: 'started.txt' }), null);
      });

      it('rejects a file call whose signal is already aborted', async () => {
        await using sandbox = await open();
        await sandbox.writeTextFile({ path: 'file.txt', content: 'keep' });
        const reason = new Error('stop');
        const abortSignal = AbortSignal.abort(reason);
        const path = 'file.txt';

        for (const call of [
          () => sandbox.readFile({ path, abortSignal }),
          () => sandbox.readBinaryFile({ path, abortSignal }),
          () => sandbox.readTextFile({ path, abortSignal }),
          () => sandbox.writeTextFile({ path, content: 'x', abortSignal }),
          () =>
            sandbox.writeBinaryFile({
              path,
              content: new Uint8Array([1]),
              abortSignal,
            }),
          () =>
            sandbox.writeFile({
              path,
              content: ReadableStream.from([new Uint8Array([1])]),
              abortSignal,
            }),
          () => sandbox.stat({ path, abortSignal }),
          () => sandbox.listDirectory({ path: '.', abortSignal }),
          () => sandbox.deleteFile({ path, abortSignal }),
        ]) {
          await assert.rejects(
            Promise.resolve(call()),
            (error) => error === reason,
          );
        }

        assert.equal(await sandbox.readTextFile({ path }), 'keep');
      });

      it('resolves every read of a missing file to null', async () => {
        await using sandbox = await open();

        assert.equal(await sandbox.readFile({ path: 'missing.txt' }), null);
        assert.equal(
          await sandbox.readBinaryFile({ path: 'missing.txt' }),
          null,
        );
        assert.equal(await sandbox.readTextFile({ path: 'missing.txt' }), null);
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
        await sandbox.writeTextFile({ path: 'dir/keep.txt', content: 'keep' });

        await assert.rejects(
          Promise.resolve(sandbox.readBinaryFile({ path: 'dir' })),
          /directory/i,
        );
      });

      it('rejects a write onto a directory and keeps its contents', async () => {
        await using sandbox = await open();
        await sandbox.writeTextFile({ path: 'dir/keep.txt', content: 'keep' });

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
        await sandbox.writeTextFile({ path: 'dir/keep.txt', content: 'keep' });
        await sandbox.writeTextFile({ path: 'target.txt', content: 'target' });
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

    describe('commands', () => {
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
        const next = await sandbox.run({ command: 'echo "[$CONTRACT_VALUE]"' });

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
    });

    describe('files', () => {
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
          await sandbox.readTextFile({ path: 'latin.txt', encoding: 'latin1' }),
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

      it('lists one directory level with entry types, reporting links as links', async () => {
        await using sandbox = await open();
        await sandbox.writeTextFile({ path: 'top/file.txt', content: 'x' });
        await sandbox.writeTextFile({ path: 'top/sub/deep.txt', content: 'x' });
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

    describe('official tool and lifecycle', () => {
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

      if (holds) {
        it('releases what the engine holds by the time dispose resolves', async () => {
          const sandboxName = `contract-${randomUUID().slice(0, 8)}`;
          const sandbox = await open(sandboxName);
          const heldWhileOpen = await holds(sandboxName);

          await sandbox.dispose();

          assert.equal(heldWhileOpen, true);
          assert.equal(await holds(sandboxName), false);
        });
      }
    });
  });
}
