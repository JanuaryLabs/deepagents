import assert from 'node:assert';
import { text as streamText } from 'node:stream/consumers';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AgentSandbox,
  type DisposableSandbox,
  createBashTool,
  createDockerSandbox,
} from '@deepagents/context';
import { Docker } from '@deepagents/test';

const docker = new Docker();

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

describe('Docker Sandbox — spawn', () => {
  let sandbox: DisposableSandbox;
  let dockerSpawn: NonNullable<DisposableSandbox['spawn']>;

  before(async () => {
    sandbox = await createDockerSandbox(docker.defaults);
    assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
    dockerSpawn = sandbox.spawn;
  });

  after(async () => {
    await sandbox.dispose();
  });

  describe('failure modes', () => {
    it('exit resolves with signal info when aborted mid-stream', async () => {
      const controller = new AbortController();
      const child = dockerSpawn('printf hi; while :; do sleep 1; done', {
        signal: controller.signal,
      });

      assert.strictEqual(await readFirstChunk(child.stdout), 'hi');

      const drained = streamText(child.stdout);
      controller.abort();

      assert.deepStrictEqual(await child.exit, {
        code: null,
        signal: 'SIGKILL',
        success: false,
      });
      await drained;
    });

    it('exit resolves with non-zero code on command failure', async () => {
      const child = dockerSpawn('exit 42');
      await streamText(child.stdout);
      await streamText(child.stderr);
      assert.deepStrictEqual(await child.exit, {
        code: 42,
        signal: null,
        success: false,
      });
    });

    it('stdout and stderr both close after the child exits', async () => {
      const child = dockerSpawn('echo hi; echo err >&2');
      const [out, err, info] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.exit,
      ]);
      assert.strictEqual(out.trim(), 'hi');
      assert.strictEqual(err.trim(), 'err');
      assert.deepStrictEqual(info, { code: 0, signal: null, success: true });
    });
  });

  describe('live streaming', () => {
    it('delivers stdout bytes before the child exits', async () => {
      const child = dockerSpawn('printf hi; sleep 1; printf bye');

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
      assert.strictEqual(rest, 'bye');
      assert.strictEqual(info.success, true);
    });

    it('streams stderr independently of stdout', async () => {
      const child = dockerSpawn(
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
    it('forwards env into the child via docker exec -e', async () => {
      const child = dockerSpawn('printf "%s" "$MY_VAR"', {
        env: { MY_VAR: 'hello-from-host' },
      });
      const text = await streamText(child.stdout);
      const info = await child.exit;
      assert.strictEqual(text, 'hello-from-host');
      assert.strictEqual(info.success, true);
    });

    it('forwards cwd into the child via docker exec -w', async () => {
      const child = dockerSpawn('pwd', { cwd: '/tmp' });
      const text = await streamText(child.stdout);
      const info = await child.exit;
      assert.strictEqual(text.trim(), '/tmp');
      assert.strictEqual(info.success, true);
    });
  });

  describe('executeCommand signal retrofit', () => {
    it('honors options.signal (no longer silently dropped)', async () => {
      const controller = new AbortController();
      const exec = sandbox.executeCommand('sleep 10', {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const result = await exec;
      assert.notStrictEqual(
        result.exitCode,
        0,
        'aborted sleep must not return a 0 exit code',
      );
    });
  });

  describe('guest process termination', () => {
    it('enforces commandTimeout for executeCommand and spawn without delayed writes', async () => {
      await using timedSandbox = await createDockerSandbox({
        ...docker.defaults,
        commandTimeout: 100,
      });

      const executeResult = await timedSandbox.executeCommand(
        'sleep 0.5; printf leaked > /workspace/execute-timeout-leaked',
      );
      assert.strictEqual(executeResult.exitCode, 124);

      assert.ok(timedSandbox.spawn);
      const child = timedSandbox.spawn(
        'printf "%s:%s" "$MANAGED" "$PWD"; printf managed-err >&2; sleep 0.5; printf leaked > /workspace/spawn-timeout-leaked',
        { cwd: '/tmp', env: { MANAGED: 'yes' } },
      );
      const [stdout, stderr, exit] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.exit,
      ]);
      assert.strictEqual(stdout, 'yes:/tmp');
      assert.match(stderr, /managed-err/);
      assert.deepStrictEqual(exit, {
        code: 124,
        signal: null,
        success: false,
      });

      await sleep(700);
      const sentinel = await timedSandbox.executeCommand(
        'test ! -e /workspace/execute-timeout-leaked && test ! -e /workspace/spawn-timeout-leaked',
      );
      assert.strictEqual(sentinel.exitCode, 0);
    });

    it('keeps caller abort distinct from the configured deadline', async () => {
      await using abortableSandbox = await createDockerSandbox({
        ...docker.defaults,
        commandTimeout: 60_000,
      });
      assert.ok(abortableSandbox.spawn);
      const controller = new AbortController();
      const child = abortableSandbox.spawn(
        'printf ready; while [ ! -e /workspace/release-aborted-command ]; do sleep 0.05; done; printf leaked > /workspace/abort-leaked',
        { signal: controller.signal },
      );

      assert.strictEqual(await readFirstChunk(child.stdout), 'ready');
      controller.abort();
      assert.deepStrictEqual(await child.exit, {
        code: null,
        signal: 'SIGKILL',
        success: false,
      });

      const sentinel = await abortableSandbox.executeCommand(
        'touch /workspace/release-aborted-command; sleep 0.2; test ! -e /workspace/abort-leaked',
      );
      assert.strictEqual(sentinel.exitCode, 0);
    });
  });

  describe('through createBashTool', () => {
    let agent: AgentSandbox;

    before(async () => {
      agent = await createBashTool({
        sandbox: await createDockerSandbox(docker.defaults),
        destination: '/workspace',
      });
      await agent.sandbox.executeCommand('mkdir -p /workspace');
    });

    after(async () => {
      await agent.sandbox.dispose();
    });

    it('exposes spawn on the wrapped sandbox', () => {
      assert.ok(
        agent.sandbox.spawn,
        'createBashTool must forward spawn from the backend',
      );
    });

    it('streams live stdout through the wrapper', async () => {
      assert.ok(agent.sandbox.spawn);
      const child = agent.sandbox.spawn('printf hi; sleep 1; printf bye');

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
      assert.strictEqual(rest, 'bye');
      assert.strictEqual(info.success, true);
    });

    // Spawn file-change tracking is covered by file-changes.integration.test.ts
    // (real strace image); this suite focuses on the spawn streaming contract.
  });
});
