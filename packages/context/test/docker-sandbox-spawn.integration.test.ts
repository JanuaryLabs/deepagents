import spawn from 'nano-spawn';
import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

import {
  type DisposableSandbox,
  createDockerSandbox,
} from '@deepagents/context';

async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
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

describe('Docker Sandbox — spawn', async () => {
  const dockerAvailable = await isDockerAvailable();

  if (!dockerAvailable) {
    console.log('Skipping Docker spawn tests: Docker not available');
    return;
  }

  let sandbox: DisposableSandbox;
  let dockerSpawn: NonNullable<DisposableSandbox['spawn']>;

  before(async () => {
    sandbox = await createDockerSandbox();
    assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
    dockerSpawn = sandbox.spawn;
  });

  after(async () => {
    await sandbox.dispose();
  });

  describe('failure modes', () => {
    it('exit resolves with signal info when aborted mid-stream', async () => {
      const controller = new AbortController();
      const child = dockerSpawn('printf hi; sleep 5; printf bye', {
        signal: controller.signal,
      });

      assert.strictEqual(await readFirstChunk(child.stdout), 'hi');

      const drained = readAllText(child.stdout);
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
      await readAllText(child.stdout);
      await readAllText(child.stderr);
      assert.deepStrictEqual(await child.exit, {
        code: 42,
        signal: null,
        success: false,
      });
    });

    it('stdout and stderr both close after the child exits', async () => {
      const child = dockerSpawn('echo hi; echo err >&2');
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

      const rest = await readAllText(child.stdout);
      const info = await child.exit;
      assert.strictEqual(rest, 'bye');
      assert.strictEqual(info.success, true);
    });

    it('streams stderr independently of stdout', async () => {
      const child = dockerSpawn(
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
    it('forwards env into the child via docker exec -e', async () => {
      const child = dockerSpawn('printf "%s" "$MY_VAR"', {
        env: { MY_VAR: 'hello-from-host' },
      });
      const text = await readAllText(child.stdout);
      const info = await child.exit;
      assert.strictEqual(text, 'hello-from-host');
      assert.strictEqual(info.success, true);
    });

    it('forwards cwd into the child via docker exec -w', async () => {
      const child = dockerSpawn('pwd', { cwd: '/tmp' });
      const text = await readAllText(child.stdout);
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
});
