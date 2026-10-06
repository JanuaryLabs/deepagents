import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';

import {
  DAYTONA_DEFAULT_DESTINATION,
  type DisposableSandbox,
  createBashTool,
  createDaytonaSandbox,
} from '@deepagents/context';

type DaytonaClient = Parameters<typeof createDaytonaSandbox>[0];

async function isDaytonaSdkAvailable(): Promise<boolean> {
  try {
    await import('@daytona/sdk');
    return true;
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

async function deleteByName(
  client: DaytonaClient | undefined,
  name: string,
): Promise<void> {
  const created = await client?.get(name).catch(() => undefined);
  await created?.delete?.();
}

interface LiveDaytonaSandbox extends AsyncDisposable {
  readonly sandbox: DisposableSandbox;
}

/**
 * Creates a uniquely named live Daytona sandbox on its own client. Disposal
 * disposes the sandbox, deletes it by name, then disposes the client.
 */
async function liveDaytonaSandbox(): Promise<LiveDaytonaSandbox> {
  await using stack = new AsyncDisposableStack();
  const { Daytona } = await import('@daytona/sdk');
  const client = stack.use(new Daytona());
  const sandboxName = `deepagents-test-${randomUUID()}`;
  stack.defer(() => deleteByName(client, sandboxName));
  const sandbox = stack.use(
    await createDaytonaSandbox(client, { name: sandboxName }),
  );
  const owned = stack.move();
  return {
    sandbox,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

describe('Daytona Sandbox', async () => {
  const sdkAvailable = await isDaytonaSdkAvailable();
  const apiKeyAvailable = Boolean(process.env.DAYTONA_API_KEY);
  const liveAvailable = sdkAvailable && apiKeyAvailable;

  if (!apiKeyAvailable) {
    console.log('Skipping Daytona live tests: DAYTONA_API_KEY not set');
  } else if (!sdkAvailable) {
    console.log('Skipping Daytona live tests: @daytona/sdk not installed');
  }

  describe('createDaytonaSandbox', { skip: !liveAvailable }, () => {
    describe('command execution', () => {
      it('captures stdout and preserves exit code on success', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        const result = await sandbox.executeCommand('printf "hello"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'hello');
        assert.strictEqual(result.stderr, '');
      });

      it('preserves non-zero exit codes and command output', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        const result = await sandbox.executeCommand(
          'echo "expected failure" >&2; exit 42',
        );
        assert.strictEqual(result.exitCode, 42);
        assert.match(`${result.stdout}${result.stderr}`, /expected failure/);
      });
    });

    describe('file operations', () => {
      it('writes and reads a file round trip', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        await sandbox.writeFiles([
          { path: '/tmp/deepagents-daytona-file.txt', content: 'hello world' },
        ]);

        const content = await sandbox.readFile(
          '/tmp/deepagents-daytona-file.txt',
        );
        assert.strictEqual(content, 'hello world');
      });

      it('reads raw bytes with the binary encoding', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);
        await sandbox.writeFiles([
          { path: '/tmp/deepagents-daytona-blob.bin', content: bytes },
        ]);

        const content = await sandbox.readFile(
          '/tmp/deepagents-daytona-blob.bin',
          { encoding: 'binary' },
        );

        assert.deepStrictEqual(Array.from(content), [0x89, 0x50, 0x00, 0xff]);
      });

      it('reports whether a path exists', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        await sandbox.writeFiles([
          { path: '/tmp/deepagents-daytona-present.txt', content: 'x' },
        ]);

        assert.strictEqual(
          await sandbox.exists('/tmp/deepagents-daytona-present.txt'),
          true,
        );
        assert.strictEqual(await sandbox.exists('/tmp'), true);
        assert.strictEqual(
          await sandbox.exists('/tmp/deepagents-daytona-missing.txt'),
          false,
        );
      });
    });

    describe('failure modes', () => {
      it('exit resolves with signal info when aborted mid-stream', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const controller = new AbortController();
        const child = sandbox.spawn(
          'printf "hi\\n"; sleep 30; printf "bye\\n"',
          {
            signal: controller.signal,
          },
        );

        assert.match(await readFirstChunk(child.stdout), /hi/);

        const drained = streamText(child.stdout);
        controller.abort();

        const info = await child.exit;
        assert.strictEqual(info.success, false);
        assert.strictEqual(info.signal, 'SIGKILL');
        await drained;
      });

      it('exit resolves with non-zero code on command failure', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const child = sandbox.spawn('exit 42');
        await streamText(child.stdout);
        await streamText(child.stderr);
        assert.deepStrictEqual(await child.exit, {
          code: 42,
          signal: null,
          success: false,
        });
      });

      it('stdout and stderr both close after the child exits', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const child = sandbox.spawn('echo hi; echo err >&2');
        const [out, err, info] = await Promise.all([
          streamText(child.stdout),
          streamText(child.stderr),
          child.exit,
        ]);
        assert.strictEqual(out.trim(), 'hi');
        assert.strictEqual(err.trim(), 'err');
        assert.deepStrictEqual(info, {
          code: 0,
          signal: null,
          success: true,
        });
      });
    });

    describe('live streaming', () => {
      it('delivers stdout bytes before the child exits', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
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

        const rest = await streamText(child.stdout);
        const info = await child.exit;
        assert.match(rest, /bye/);
        assert.strictEqual(info.success, true);
      });

      it('streams stderr independently of stdout', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const child = sandbox.spawn(
          'echo "to stdout"; echo "to stderr" >&2; echo "also stdout"',
        );
        const [out, err] = await Promise.all([
          streamText(child.stdout),
          streamText(child.stderr),
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
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const child = sandbox.spawn('printf "%s\\n" "$MY_VAR"', {
          env: { MY_VAR: 'hello-from-host' },
        });
        const text = await streamText(child.stdout);
        const info = await child.exit;
        assert.strictEqual(text.trim(), 'hello-from-host');
        assert.strictEqual(info.success, true);
      });

      it('forwards cwd into the child', async () => {
        await using live = await liveDaytonaSandbox();
        const { sandbox } = live;
        assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
        const cwd = '/tmp/deepagents-daytona-cwd';
        const mkdir = await sandbox.executeCommand(`mkdir -p ${cwd}`);
        assert.strictEqual(mkdir.exitCode, 0);

        const child = sandbox.spawn('pwd', { cwd });
        const text = await streamText(child.stdout);
        const info = await child.exit;
        assert.strictEqual(text.trim(), cwd);
        assert.strictEqual(info.success, true);
      });
    });
  });

  describe(
    'createDaytonaSandbox + createBashTool',
    { skip: !liveAvailable },
    () => {
      it('exposes spawn on the wrapped sandbox', async () => {
        await using live = await liveDaytonaSandbox();
        const mkdir = await live.sandbox.executeCommand(
          `mkdir -p ${DAYTONA_DEFAULT_DESTINATION}`,
        );
        assert.strictEqual(mkdir.exitCode, 0);
        const agent = await createBashTool({
          sandbox: live.sandbox,
          destination: DAYTONA_DEFAULT_DESTINATION,
        });
        assert.ok(
          agent.sandbox.spawn,
          'createBashTool must forward spawn from the backend',
        );
      });

      it('streams live stdout through the wrapper', async () => {
        await using live = await liveDaytonaSandbox();
        const mkdir = await live.sandbox.executeCommand(
          `mkdir -p ${DAYTONA_DEFAULT_DESTINATION}`,
        );
        assert.strictEqual(mkdir.exitCode, 0);
        const agent = await createBashTool({
          sandbox: live.sandbox,
          destination: DAYTONA_DEFAULT_DESTINATION,
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

        const rest = await streamText(child.stdout);
        const info = await child.exit;
        assert.match(rest, /bye/);
        assert.strictEqual(info.success, true);
      });

      // Spawn file-change tracking is covered by file-changes.integration.test.ts;
      // this suite focuses on the spawn streaming contract over Daytona.
    },
  );
});
