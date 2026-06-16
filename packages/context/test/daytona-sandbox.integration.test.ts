import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  type AgentSandbox,
  DAYTONA_DEFAULT_DESTINATION,
  type DisposableSandbox,
  createBashTool,
  createDaytonaSandbox,
} from '@deepagents/context';

type DaytonaClient = Parameters<typeof createDaytonaSandbox>[0];

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as DynamicImport;

async function isDaytonaSdkAvailable(): Promise<boolean> {
  try {
    await dynamicImport('@daytona/sdk');
    return true;
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

async function deleteByName(
  client: DaytonaClient | undefined,
  name: string,
): Promise<void> {
  const created = await client?.get(name).catch(() => undefined);
  await created?.delete?.();
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
    let client: DaytonaClient;
    let sandboxName: string;
    let sandbox: DisposableSandbox;
    let daytonaSpawn: NonNullable<DisposableSandbox['spawn']>;

    before(async () => {
      const { Daytona } = await import('@daytona/sdk');
      client = new Daytona();
      sandboxName = `deepagents-test-${randomUUID()}`;
      sandbox = await createDaytonaSandbox(client, { name: sandboxName });
      assert.ok(sandbox.spawn, 'daytona sandbox must expose spawn');
      daytonaSpawn = sandbox.spawn;
    });

    after(async () => {
      await sandbox?.dispose();
      await deleteByName(client, sandboxName);
    });

    describe('command execution', () => {
      it('captures stdout and preserves exit code on success', async () => {
        const result = await sandbox.executeCommand('printf "hello"');
        assert.strictEqual(result.exitCode, 0);
        assert.strictEqual(result.stdout, 'hello');
        assert.strictEqual(result.stderr, '');
      });

      it('preserves non-zero exit codes and command output', async () => {
        const result = await sandbox.executeCommand(
          'echo "expected failure" >&2; exit 42',
        );
        assert.strictEqual(result.exitCode, 42);
        assert.match(`${result.stdout}${result.stderr}`, /expected failure/);
      });
    });

    describe('file operations', () => {
      it('writes and reads a file round trip', async () => {
        await sandbox.writeFiles([
          { path: '/tmp/deepagents-daytona-file.txt', content: 'hello world' },
        ]);

        const content = await sandbox.readFile(
          '/tmp/deepagents-daytona-file.txt',
        );
        assert.strictEqual(content, 'hello world');
      });
    });

    describe('failure modes', () => {
      it('exit resolves with signal info when aborted mid-stream', async () => {
        const controller = new AbortController();
        const child = daytonaSpawn(
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
        const child = daytonaSpawn('exit 42');
        await readAllText(child.stdout);
        await readAllText(child.stderr);
        assert.deepStrictEqual(await child.exit, {
          code: 42,
          signal: null,
          success: false,
        });
      });

      it('stdout and stderr both close after the child exits', async () => {
        const child = daytonaSpawn('echo hi; echo err >&2');
        const [out, err, info] = await Promise.all([
          readAllText(child.stdout),
          readAllText(child.stderr),
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
        const child = daytonaSpawn('printf "hi\\n"; sleep 2; printf "bye\\n"');

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
        const child = daytonaSpawn(
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
        const child = daytonaSpawn('printf "%s\\n" "$MY_VAR"', {
          env: { MY_VAR: 'hello-from-host' },
        });
        const text = await readAllText(child.stdout);
        const info = await child.exit;
        assert.strictEqual(text.trim(), 'hello-from-host');
        assert.strictEqual(info.success, true);
      });

      it('forwards cwd into the child', async () => {
        const cwd = '/tmp/deepagents-daytona-cwd';
        const mkdir = await sandbox.executeCommand(`mkdir -p ${cwd}`);
        assert.strictEqual(mkdir.exitCode, 0);

        const child = daytonaSpawn('pwd', { cwd });
        const text = await readAllText(child.stdout);
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
      let agent: AgentSandbox;
      let client: DaytonaClient;
      let sandboxName: string;

      before(async () => {
        const { Daytona } = await import('@daytona/sdk');
        client = new Daytona();
        sandboxName = `deepagents-test-${randomUUID()}`;
        const backend = await createDaytonaSandbox(client, {
          name: sandboxName,
        });
        const mkdir = await backend.executeCommand(
          `mkdir -p ${DAYTONA_DEFAULT_DESTINATION}`,
        );
        assert.strictEqual(mkdir.exitCode, 0);
        agent = await createBashTool({
          sandbox: backend,
          destination: DAYTONA_DEFAULT_DESTINATION,
        });
      });

      after(async () => {
        await agent?.sandbox.dispose();
        await deleteByName(client, sandboxName);
      });

      it('exposes spawn on the wrapped sandbox', () => {
        assert.ok(
          agent.sandbox.spawn,
          'createBashTool must forward spawn from the backend',
        );
      });

      it('streams live stdout through the wrapper', async () => {
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
      });

      // Spawn file-change tracking is covered by file-changes.integration.test.ts;
      // this suite focuses on the spawn streaming contract over Daytona.
    },
  );
});
