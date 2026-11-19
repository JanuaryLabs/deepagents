import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';

import { createBashTool, createDaytonaSandbox } from '@deepagents/context';

import { readFirstChunk } from './helpers/read-first-chunk.ts';

type DaytonaClient = Parameters<typeof createDaytonaSandbox>[0];

const LITERAL_LINE = "line one's $HOME `whoami`";

async function daytonaClient(): Promise<DaytonaClient | undefined> {
  if (!process.env.DAYTONA_API_KEY) return undefined;
  try {
    const { Daytona } = await import('@daytona/sdk');
    return new Daytona().v2;
  } catch {
    return undefined;
  }
}

function literalHeredoc(exitCode?: number): string {
  return [
    "cat <<'DEEPAGENTS_PAYLOAD'",
    LITERAL_LINE,
    'DEEPAGENTS_PAYLOAD',
    ...(exitCode === undefined ? [] : [`exit ${exitCode}`]),
  ].join('\n');
}

const client = await daytonaClient();
const skip = client
  ? undefined
  : 'DAYTONA_API_KEY is not set or @daytona/sdk is not installed';

function live(): DaytonaClient {
  assert.ok(client, 'live Daytona tests run only with a client');
  return client;
}

describe('Daytona Sandbox', { skip }, () => {
  describe('command execution', () => {
    it('captures stdout and preserves exit code on success', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const result = await sandbox.run({ command: 'printf "hello"' });
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, 'hello');
      assert.strictEqual(result.stderr, '');
    });

    it('preserves non-zero exit codes and command output', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const result = await sandbox.run({
        command: 'echo "expected failure" >&2; exit 42',
      });
      assert.strictEqual(result.exitCode, 42);
      assert.match(`${result.stdout}${result.stderr}`, /expected failure/);
    });

    it('ends a command at commandTimeout with exit 124', async () => {
      await using sandbox = await createDaytonaSandbox(live(), {
        commandTimeout: 1_000,
      });

      const result = await sandbox.run({
        command: 'echo before; sleep 30; echo after',
      });
      const child = await sandbox.spawn({ command: 'sleep 30' });
      const [, spawnedStderr, { exitCode }] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.wait(),
      ]);

      assert.deepStrictEqual(result, {
        stdout: 'before\n',
        stderr: 'Command timed out',
        exitCode: 124,
      });
      assert.strictEqual(exitCode, 124);
      assert.strictEqual(spawnedStderr, 'Command timed out');
    });
  });

  describe('Bash contract', () => {
    it('preserves Bash arrays through createBashTool', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const { bash } = await createBashTool({
        sandbox,
        workingDirectory: '/tmp/bash-contract',
      });
      const execute = bash.execute;
      assert.ok(execute);

      const result = await execute(
        {
          command:
            'values=(one "two three"); printf \'<%s>\\n\' "${values[1]}"',
          reasoning: 'verify Daytona preserves Bash array syntax',
        },
        {
          abortSignal: undefined,
          context: {},
          messages: [],
          toolCallId: 'daytona-bash-array-contract',
        },
      );

      assert.deepStrictEqual(result, {
        stdout: '<two three>\n',
        stderr: '',
        exitCode: 0,
      });
    });

    it('preserves literal heredoc content through run', async () => {
      await using sandbox = await createDaytonaSandbox(live());

      const result = await sandbox.run({ command: literalHeredoc() });

      assert.deepStrictEqual(result, {
        stdout: `${LITERAL_LINE}\n`,
        stderr: '',
        exitCode: 0,
      });
    });

    it('preserves a deliberate non-zero exit after complex quoting', async () => {
      await using sandbox = await createDaytonaSandbox(live());

      const result = await sandbox.run({ command: literalHeredoc(37) });

      assert.strictEqual(result.stdout, `${LITERAL_LINE}\n`);
      assert.strictEqual(result.exitCode, 37);
    });

    it('preserves complex command text and exit code through spawn', async () => {
      await using sandbox = await createDaytonaSandbox(live());

      const child = await sandbox.spawn({ command: literalHeredoc(43) });
      const [stdout, stderr, exit] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.wait(),
      ]);

      assert.strictEqual(stdout, `${LITERAL_LINE}\n`);
      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(exit, { exitCode: 43 });
    });

    it('preserves tricky env values and the working directory through spawn', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const cwd = "/tmp/daytona cwd one's $HOME `whoami`";
      const envValue = "env value one's $HOME `whoami` with spaces";
      const createCwd = await sandbox.run({
        command: [
          "cwd=$(cat <<'DEEPAGENTS_CWD'",
          cwd,
          'DEEPAGENTS_CWD',
          ')',
          'mkdir -p -- "$cwd"',
        ].join('\n'),
      });
      assert.strictEqual(createCwd.exitCode, 0, createCwd.stderr);

      const child = await sandbox.spawn({
        command: 'printf \'<%s>\\n<%s>\\n\' "$TRICKY_VALUE" "$PWD"',
        workingDirectory: cwd,
        env: { TRICKY_VALUE: envValue },
      });
      const [stdout, stderr, exit] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.wait(),
      ]);

      assert.strictEqual(stdout, `<${envValue}>\n<${cwd}>\n`);
      assert.strictEqual(stderr, '');
      assert.deepStrictEqual(exit, { exitCode: 0 });
    });
  });

  describe('file operations', () => {
    it('writes and reads a file round trip', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      await sandbox.writeTextFile({
        path: '/tmp/deepagents-daytona-file.txt',
        content: 'hello world',
      });

      const content = await sandbox.readTextFile({
        path: '/tmp/deepagents-daytona-file.txt',
      });
      assert.strictEqual(content, 'hello world');
    });

    it('reads raw bytes with readBinaryFile', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff]);
      await sandbox.writeBinaryFile({
        path: '/tmp/deepagents-daytona-blob.bin',
        content: bytes,
      });

      const content = await sandbox.readBinaryFile({
        path: '/tmp/deepagents-daytona-blob.bin',
      });

      assert.deepStrictEqual(
        Array.from(content ?? []),
        [0x89, 0x50, 0x00, 0xff],
      );
    });

    it('reports whether a path exists', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      await sandbox.writeTextFile({
        path: '/tmp/deepagents-daytona-present.txt',
        content: 'x',
      });

      assert.deepStrictEqual(
        await sandbox.stat({ path: '/tmp/deepagents-daytona-present.txt' }),
        { type: 'file', size: 1 },
      );
      assert.strictEqual(
        (await sandbox.stat({ path: '/tmp' }))?.type,
        'directory',
      );
      assert.strictEqual(
        await sandbox.stat({ path: '/tmp/deepagents-daytona-missing.txt' }),
        null,
      );
    });
  });

  describe('failure modes', () => {
    it('wait rejects with the abort reason when aborted mid-stream', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const controller = new AbortController();
      const reason = new Error('stop');
      const child = await sandbox.spawn({
        command: 'printf "hi\\n"; sleep 300; printf "bye\\n"',
        abortSignal: controller.signal,
      });

      assert.match(await readFirstChunk(child.stdout), /hi/);

      const drained = streamText(child.stdout);
      controller.abort(reason);

      // sleep 300 outlives the 240 s test timeout: a wait that waits the command out fails the test.
      await assert.rejects(
        Promise.resolve(child.wait()),
        (error) => error === reason,
      );
      assert.doesNotMatch(await drained, /bye/);
    });

    it('wait resolves with non-zero code on command failure', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const child = await sandbox.spawn({ command: 'exit 42' });
      await streamText(child.stdout);
      await streamText(child.stderr);
      assert.deepStrictEqual(await child.wait(), { exitCode: 42 });
    });

    it('stdout and stderr both close after the child exits', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const child = await sandbox.spawn({ command: 'echo hi; echo err >&2' });
      const [out, err, exit] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.wait(),
      ]);
      assert.strictEqual(out.trim(), 'hi');
      assert.strictEqual(err.trim(), 'err');
      assert.deepStrictEqual(exit, { exitCode: 0 });
    });

    it('propagates the SDK error when the sandboxId does not exist', async () => {
      const { NotFoundError } = await import('@daytona/sdk/v2');

      await assert.rejects(
        createDaytonaSandbox(live(), {
          sandboxId: `sbx_missing${randomUUID().replaceAll('-', '')}`,
        }),
        NotFoundError,
      );
    });

    it('propagates the SDK conflict when a name is reused with other options', async () => {
      const { ConflictError } = await import('@daytona/sdk/v2');
      const name = `deepagents-conflict-${randomUUID()}`;
      await using sandbox = await createDaytonaSandbox(live(), { name });

      await assert.rejects(
        createDaytonaSandbox(live(), { name, labels: { other: 'options' } }),
        ConflictError,
      );
      assert.strictEqual(
        (await sandbox.run({ command: 'echo up' })).stdout,
        'up\n',
      );
    });
  });

  describe('live streaming', () => {
    it('delivers stdout bytes before the child exits', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const child = await sandbox.spawn({
        command: 'printf "hi\\n"; sleep 2; printf "bye\\n"',
      });

      const winner = await Promise.race([
        readFirstChunk(child.stdout).then(() => 'chunk' as const),
        child.wait().then(() => 'exit' as const),
      ]);
      assert.strictEqual(
        winner,
        'chunk',
        'first stdout chunk must arrive before the child exits (proves live streaming)',
      );

      const rest = await streamText(child.stdout);
      assert.match(rest, /bye/);
      assert.deepStrictEqual(await child.wait(), { exitCode: 0 });
    });

    it('streams stderr independently of stdout', async () => {
      await using sandbox = await createDaytonaSandbox(live());
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
      await using sandbox = await createDaytonaSandbox(live());
      const child = await sandbox.spawn({
        command: 'printf "%s\\n" "$MY_VAR"',
        env: { MY_VAR: 'hello-from-host' },
      });
      const text = await streamText(child.stdout);
      assert.strictEqual(text.trim(), 'hello-from-host');
      assert.deepStrictEqual(await child.wait(), { exitCode: 0 });
    });

    it('forwards the working directory into the child', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const cwd = '/tmp/deepagents-daytona-cwd';
      const mkdir = await sandbox.run({ command: `mkdir -p ${cwd}` });
      assert.strictEqual(mkdir.exitCode, 0);

      const child = await sandbox.spawn({
        command: 'pwd',
        workingDirectory: cwd,
      });
      const text = await streamText(child.stdout);
      assert.strictEqual(text.trim(), cwd);
      assert.deepStrictEqual(await child.wait(), { exitCode: 0 });
    });
  });

  describe('lifecycle', () => {
    it('deletes a sandbox it created and leaves one it attached to by name', async () => {
      const name = `deepagents-owner-${randomUUID()}`;
      await using owner = await createDaytonaSandbox(live(), { name });
      await owner.writeTextFile({ path: '/tmp/marker', content: 'first' });
      const attached = await createDaytonaSandbox(live(), { name });
      assert.strictEqual(
        await attached.readTextFile({ path: '/tmp/marker' }),
        'first',
      );

      await attached.dispose();
      assert.strictEqual(
        await owner.readTextFile({ path: '/tmp/marker' }),
        'first',
      );

      await owner.dispose();
      await using fresh = await createDaytonaSandbox(live(), { name });
      assert.strictEqual(
        await fresh.readTextFile({ path: '/tmp/marker' }),
        null,
      );
    });

    it('leaves a sandbox it attached to by sandboxId', async () => {
      const existing = await live().create({
        name: `deepagents-attach-${randomUUID()}`,
      });
      try {
        const attached = await createDaytonaSandbox(live(), {
          sandboxId: existing.id,
        });
        await attached.dispose();

        await existing.refreshData();
        assert.strictEqual(existing.state, 'started');
      } finally {
        await existing.delete();
      }
    });
  });

  describe('createDaytonaSandbox + createBashTool', () => {
    it('streams live stdout through the wrapper', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const agent = await createBashTool({
        sandbox,
        workingDirectory: '/tmp/bash-tool',
      });
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
      assert.match(rest, /bye/);
      assert.deepStrictEqual(await child.wait(), { exitCode: 0 });
    });
  });
});
