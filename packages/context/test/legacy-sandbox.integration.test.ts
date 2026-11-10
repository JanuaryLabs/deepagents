import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { type TestContext, describe, it } from 'node:test';

import {
  DAYTONA_DEFAULT_DESTINATION,
  type FileChange,
  createBashTool,
  createDaytonaSandbox,
  withStraceFileChanges,
} from '@deepagents/context';

const HOME = DAYTONA_DEFAULT_DESTINATION;
const LEGACY = `${HOME}/legacy`;

/**
 * Daytona is the last backend on the old contract. Its `dispose` leaves the
 * remote sandbox to the caller's client, so the scope deletes it.
 */
async function open() {
  const { Daytona } = await import('@daytona/sdk');
  const client = new Daytona();
  const name = `deepagents-legacy-${randomUUID()}`;
  const remove = async () => {
    const remote = await client.get(name).catch(() => undefined);
    await remote?.delete();
  };
  try {
    const backend = await createDaytonaSandbox(client, { name });
    return Object.assign(backend, {
      [Symbol.asyncDispose]: async () => {
        try {
          await backend.dispose();
        } finally {
          await remove();
        }
      },
    });
  } catch (error) {
    await remove();
    throw error;
  }
}

async function daytonaUnavailable(): Promise<string | undefined> {
  if (!process.env.DAYTONA_API_KEY) return 'DAYTONA_API_KEY is not set';
  try {
    await import('@daytona/sdk');
    return undefined;
  } catch {
    return '@daytona/sdk is not installed';
  }
}

function executionOptions(toolCallId: string) {
  return { abortSignal: undefined, context: {}, messages: [], toolCallId };
}

const skip = await daytonaUnavailable();

describe('a backend still on the old contract', { skip }, () => {
  it('serves the bash, write and read tools', async () => {
    await using backend = await open();
    const { tools } = await createBashTool({
      sandbox: backend,
      workingDirectory: LEGACY,
    });
    assert.ok(tools.bash.execute);
    assert.ok(tools.writeFile.execute);
    assert.ok(tools.readFile.execute);

    const shell = await tools.bash.execute(
      { command: 'pwd', reasoning: 'find the working directory' },
      executionOptions('pwd'),
    );
    await tools.writeFile.execute(
      { path: 'notes.txt', content: 'hello' },
      executionOptions('write'),
    );
    const read = await tools.readFile.execute(
      { path: 'notes.txt' },
      executionOptions('read'),
    );

    assert.ok(!(Symbol.asyncIterator in shell));
    assert.equal(shell.stdout.trim(), LEGACY);
    assert.equal(shell.exitCode, 0);
    assert.deepEqual(read, { type: 'text', value: 'hello' });
  });

  it('answers session file calls, with null for a missing path', async () => {
    await using backend = await open();
    const { sandbox } = await createBashTool({
      sandbox: backend,
      workingDirectory: LEGACY,
    });
    const bytes = [0xff, 0x00, 0xfe];

    await sandbox.writeBinaryFile({
      path: `${LEGACY}/blob.bin`,
      content: new Uint8Array(bytes),
    });
    await sandbox.writeTextFile({
      path: `${LEGACY}/lines.txt`,
      content: 'a\nb\nc\n',
    });

    const blob = await sandbox.readBinaryFile({
      path: `${LEGACY}/blob.bin`,
    });
    assert.deepEqual([...(blob ?? [])], bytes);
    assert.equal(
      await sandbox.readTextFile({
        path: `${LEGACY}/lines.txt`,
        startLine: 2,
        endLine: 2,
      }),
      'b',
    );
    assert.deepEqual(await sandbox.stat({ path: `${LEGACY}/blob.bin` }), {
      type: 'file',
      size: 3,
    });
    assert.equal((await sandbox.stat({ path: LEGACY }))?.type, 'directory');
    assert.equal(await sandbox.stat({ path: `${HOME}/missing` }), null);
    assert.equal(await sandbox.readTextFile({ path: `${HOME}/missing` }), null);
    assert.equal(
      await sandbox.readBinaryFile({ path: `${HOME}/missing` }),
      null,
    );
  });

  it('applies workingDirectory and env, and reports spawn output', async () => {
    await using backend = await open();
    const { sandbox } = await createBashTool({
      sandbox: backend,
      workingDirectory: LEGACY,
    });

    const { stdout } = await sandbox.run({
      command: 'pwd; echo "[$LEGACY_VALUE]"',
      workingDirectory: '/tmp',
      env: { LEGACY_VALUE: 'it has spaces' },
    });
    const finished = await sandbox.spawn({
      command: 'echo out; echo err >&2; exit 4',
    });
    const [spawnedOut, spawnedErr, exit] = await Promise.all([
      text(finished.stdout),
      text(finished.stderr),
      finished.wait(),
    ]);

    assert.equal(stdout.trim(), '/tmp\n[it has spaces]');
    assert.deepEqual(
      { spawnedOut, spawnedErr, exit },
      { spawnedOut: 'out\n', spawnedErr: 'err\n', exit: { exitCode: 4 } },
    );
  });

  it('stops a spawned process on abort and on kill', async (t: TestContext) => {
    await using backend = await open();
    const { sandbox } = await createBashTool({
      sandbox: backend,
      workingDirectory: LEGACY,
    });
    const controller = new AbortController();
    const reason = new Error('stop');
    const started = (name: string) =>
      t.waitFor(
        async () =>
          assert.equal(
            await sandbox.readTextFile({ path: `/tmp/${name}-started` }),
            'started\n',
          ),
        { interval: 100, timeout: 30_000 },
      );
    const command = (name: string) =>
      `echo started > /tmp/${name}-started; sleep 3; echo late > /tmp/${name}-late`;

    const aborted = await sandbox.spawn({
      command: command('aborted'),
      abortSignal: controller.signal,
    });
    await started('aborted');
    controller.abort(reason);
    await assert.rejects(
      Promise.resolve(aborted.wait()),
      (error) => error === reason,
    );

    const killed = await sandbox.spawn({ command: command('killed') });
    await started('killed');
    await killed.kill();
    await killed.wait();

    assert.equal(await sandbox.stat({ path: '/tmp/aborted-late' }), null);
    assert.equal(await sandbox.stat({ path: '/tmp/killed-late' }), null);
  });

  it('is traced by withStraceFileChanges through the shim', async () => {
    await using backend = await open();
    const installed = await backend.executeCommand('command -v strace');
    assert.equal(installed.exitCode, 0, installed.stderr);
    const seen: FileChange[] = [];
    const tracked = await withStraceFileChanges(backend, {
      include: [HOME, `${HOME}/**`],
      onFileChanges: (changes) => {
        seen.push(...changes);
      },
    });

    const result = await tracked.run({
      command: `echo traced > ${HOME}/traced.txt`,
    });
    await tracked.writeTextFile({
      path: `${HOME}/written.txt`,
      content: 'written',
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      seen.map(({ op, path }) => ({ op, path })),
      [
        { op: 'write', path: `${HOME}/traced.txt` },
        { op: 'write', path: `${HOME}/written.txt` },
      ],
    );
  });
});
