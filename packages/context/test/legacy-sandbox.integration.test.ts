import assert from 'node:assert/strict';
import { text } from 'node:stream/consumers';
import { type TestContext, describe, it } from 'node:test';

import {
  type FileChange,
  MICROSANDBOX_DEFAULT_DESTINATION,
  MicrosandboxNotAvailableError,
  createBashTool,
  createMicrosandboxSandbox,
  withStraceFileChanges,
} from '@deepagents/context';

/** Microsandbox stays on the old contract until its own port; Docker no longer is. */
const open = () => createMicrosandboxSandbox();

async function microsandboxUnavailable(): Promise<string | undefined> {
  try {
    await (await open()).dispose();
    return undefined;
  } catch (error) {
    if (error instanceof MicrosandboxNotAvailableError) return error.message;
    throw error;
  }
}

function executionOptions(toolCallId: string) {
  return { abortSignal: undefined, context: {}, messages: [], toolCallId };
}

const skip = await microsandboxUnavailable();

describe('a backend still on the old contract', { skip }, () => {
  it('serves the bash, write and read tools', async () => {
    await using backend = await open();
    const { tools } = await createBashTool({
      sandbox: backend,
      workingDirectory: '/workspace/legacy',
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
    assert.equal(shell.stdout.trim(), '/workspace/legacy');
    assert.equal(shell.exitCode, 0);
    assert.deepEqual(read, { type: 'text', value: 'hello' });
  });

  it('answers session file calls, with null for a missing path', async () => {
    await using backend = await open();
    const { sandbox } = await createBashTool({
      sandbox: backend,
      workingDirectory: '/workspace/legacy',
    });
    const bytes = [0xff, 0x00, 0xfe];

    await sandbox.writeBinaryFile({
      path: '/workspace/legacy/blob.bin',
      content: new Uint8Array(bytes),
    });
    await sandbox.writeTextFile({
      path: '/workspace/legacy/lines.txt',
      content: 'a\nb\nc\n',
    });

    const blob = await sandbox.readBinaryFile({
      path: '/workspace/legacy/blob.bin',
    });
    assert.deepEqual([...(blob ?? [])], bytes);
    assert.equal(
      await sandbox.readTextFile({
        path: '/workspace/legacy/lines.txt',
        startLine: 2,
        endLine: 2,
      }),
      'b',
    );
    assert.deepEqual(
      await sandbox.stat({ path: '/workspace/legacy/blob.bin' }),
      {
        type: 'file',
        size: 3,
      },
    );
    assert.equal(
      (await sandbox.stat({ path: '/workspace/legacy' }))?.type,
      'directory',
    );
    assert.equal(await sandbox.stat({ path: '/workspace/missing' }), null);
    assert.equal(
      await sandbox.readTextFile({ path: '/workspace/missing' }),
      null,
    );
    assert.equal(
      await sandbox.readBinaryFile({ path: '/workspace/missing' }),
      null,
    );
  });

  it('applies workingDirectory and env, and reports spawn output', async () => {
    await using backend = await open();
    const { sandbox } = await createBashTool({
      sandbox: backend,
      workingDirectory: '/workspace/legacy',
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
      workingDirectory: '/workspace/legacy',
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
    const installed = await backend.executeCommand('apk add --no-cache strace');
    assert.equal(installed.exitCode, 0, installed.stderr);
    const seen: FileChange[] = [];
    const tracked = await withStraceFileChanges(backend, {
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

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      seen.map(({ op, path }) => ({ op, path })),
      [
        { op: 'write', path: `${MICROSANDBOX_DEFAULT_DESTINATION}/traced.txt` },
        {
          op: 'write',
          path: `${MICROSANDBOX_DEFAULT_DESTINATION}/written.txt`,
        },
      ],
    );
  });
});
