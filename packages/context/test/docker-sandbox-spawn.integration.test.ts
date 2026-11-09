import { DockerTestbed } from '@zukhruf/testing/docker';
import assert from 'node:assert';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createBashTool, createDockerSandbox } from '@deepagents/context';

import { dockerSandboxDefaults } from './helpers/docker-sandbox-defaults.ts';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = dockerSandboxDefaults(testbed.defaults);

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
  describe('failure modes', () => {
    it('wait rejects with the abort reason when aborted mid-stream', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
      const controller = new AbortController();
      const reason = new Error('stop');
      const child = await sandbox.spawn({
        command: 'printf hi; while :; do sleep 1; done',
        abortSignal: controller.signal,
      });

      assert.strictEqual(await readFirstChunk(child.stdout), 'hi');

      const drained = streamText(child.stdout);
      controller.abort(reason);

      await assert.rejects(
        Promise.resolve(child.wait()),
        (error) => error === reason,
      );
      await drained;
    });

    it('exit resolves with non-zero code on command failure', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
      const child = await sandbox.spawn({ command: 'exit 42' });
      await streamText(child.stdout);
      await streamText(child.stderr);
      assert.deepStrictEqual(await child.wait(), { exitCode: 42 });
    });

    it('stdout and stderr both close after the child exits', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
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
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
      const child = await sandbox.spawn({
        command: 'printf hi; sleep 1; printf bye',
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
      assert.strictEqual(rest, 'bye');
      assert.strictEqual(info.exitCode, 0);
    });

    it('streams stderr independently of stdout', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
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
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
      const child = await sandbox.spawn({
        command: 'printf "%s" "$MY_VAR"',
        env: { MY_VAR: 'hello-from-host' },
      });
      const text = await streamText(child.stdout);
      const info = await child.wait();
      assert.strictEqual(text, 'hello-from-host');
      assert.strictEqual(info.exitCode, 0);
    });

    it('forwards the working directory into the child', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      assert.ok(sandbox.spawn, 'docker sandbox must expose spawn');
      const child = await sandbox.spawn({
        command: 'pwd',
        workingDirectory: '/tmp',
      });
      const text = await streamText(child.stdout);
      const info = await child.wait();
      assert.strictEqual(text.trim(), '/tmp');
      assert.strictEqual(info.exitCode, 0);
    });
  });

  describe('run signal retrofit', () => {
    it('honors abortSignal (no longer silently dropped)', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      const controller = new AbortController();
      const exec = sandbox.run({
        command: 'sleep 10; touch /workspace/after-abort',
        abortSignal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      const result = await exec;
      assert.notStrictEqual(
        result.exitCode,
        0,
        'aborted sleep must not return a 0 exit code',
      );
      await sleep(10_500);
      assert.strictEqual(
        await sandbox.stat({ path: '/workspace/after-abort' }),
        null,
      );
    });
  });

  describe('guest process termination', () => {
    it('enforces commandTimeout for run and spawn without delayed writes', async () => {
      await using timedSandbox = await createDockerSandbox({
        ...defaults,
        commandTimeout: 100,
      });

      const executeResult = await timedSandbox.run({
        command: 'sleep 0.5; printf leaked > /workspace/execute-timeout-leaked',
      });
      assert.strictEqual(executeResult.exitCode, 124);

      assert.ok(timedSandbox.spawn);
      const child = await timedSandbox.spawn({
        command:
          'printf "%s:%s" "$MANAGED" "$PWD"; printf managed-err >&2; sleep 0.5; printf leaked > /workspace/spawn-timeout-leaked',
        workingDirectory: '/tmp',
        env: { MANAGED: 'yes' },
      });
      const [stdout, stderr, exit] = await Promise.all([
        streamText(child.stdout),
        streamText(child.stderr),
        child.wait(),
      ]);
      assert.strictEqual(stdout, 'yes:/tmp');
      assert.match(stderr, /managed-err/);
      assert.deepStrictEqual(exit, { exitCode: 124 });

      await sleep(700);
      const sentinel = await timedSandbox.run({
        command:
          'test ! -e /workspace/execute-timeout-leaked && test ! -e /workspace/spawn-timeout-leaked',
      });
      assert.strictEqual(sentinel.exitCode, 0);
    });

    it('keeps caller abort distinct from the configured deadline', async () => {
      await using abortableSandbox = await createDockerSandbox({
        ...defaults,
        commandTimeout: 60_000,
      });
      assert.ok(abortableSandbox.spawn);
      const controller = new AbortController();
      const reason = new Error('stop');
      const child = await abortableSandbox.spawn({
        command:
          'printf ready; while [ ! -e /workspace/release-aborted-command ]; do sleep 0.05; done; printf leaked > /workspace/abort-leaked',
        abortSignal: controller.signal,
      });

      assert.strictEqual(await readFirstChunk(child.stdout), 'ready');
      controller.abort(reason);
      await assert.rejects(
        Promise.resolve(child.wait()),
        (error) => error === reason,
      );

      const sentinel = await abortableSandbox.run({
        command:
          'touch /workspace/release-aborted-command; sleep 0.2; test ! -e /workspace/abort-leaked',
      });
      assert.strictEqual(sentinel.exitCode, 0);
    });
  });

  describe('through createBashTool', () => {
    it('exposes spawn on the wrapped sandbox', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      const agent = await createBashTool({
        sandbox,
        workingDirectory: '/workspace',
      });
      assert.ok(
        agent.sandbox.spawn,
        'createBashTool must forward spawn from the backend',
      );
    });

    it('streams live stdout through the wrapper', async () => {
      await using sandbox = await createDockerSandbox(defaults);
      const agent = await createBashTool({
        sandbox,
        workingDirectory: '/workspace',
      });
      assert.ok(agent.sandbox.spawn);
      const child = await agent.sandbox.spawn({
        command: 'printf hi; sleep 1; printf bye',
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
      assert.strictEqual(rest, 'bye');
      assert.strictEqual(info.exitCode, 0);
    });

    // Spawn file-change tracking is covered by file-changes.integration.test.ts
    // (real strace image); this suite focuses on the spawn streaming contract.
  });
});
