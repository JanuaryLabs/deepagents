import { DockerTestbed } from '@zukhruf/testing/docker';
import { type UIMessage, generateId, isToolUIPart } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type CommandResult,
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createDockerSandbox,
} from '@deepagents/context';

import { dockerSandboxDefaults } from './helpers/docker-sandbox-defaults.ts';
import { textResult, toolCallResult } from './helpers/stream-results.ts';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = dockerSandboxDefaults(testbed.defaults);

function userMessage(text: string): UIMessage {
  return { id: generateId(), role: 'user', parts: [{ type: 'text', text }] };
}

/** Calls `bash` with `command` first, and answers in text from then on. */
function bashThenText(command: string) {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({
    doStream: async () =>
      model.doStreamCalls.length === 1
        ? toolCallResult({
            toolCallId: 'call-1',
            toolName: 'bash',
            input: JSON.stringify({ command, reasoning: 'run it' }),
          })
        : textResult('done'),
  });
  return model;
}

async function storedBashPart(store: InMemoryContextStore, chatId: string) {
  const branch = await store.getActiveBranch(chatId);
  assert.ok(branch?.headMessageId);
  const chain = await store.getMessageChain(branch.headMessageId);
  const part = chain
    .flatMap((entry) => (entry.data as UIMessage).parts)
    .find(isToolUIPart);
  assert.ok(part);
  return part;
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
      await assert.rejects(
        Promise.resolve(exec),
        (error) => error === controller.signal.reason,
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
    it('records a cancelled bash call when the turn aborts, ends the turn, and lets the next turn replay it', async (t) => {
      await using backend = await createDockerSandbox(defaults);
      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        store,
        chatId: 'aborted-turn',
        userId: 'user',
      });
      const model = bashThenText('touch started; sleep 10; touch late');
      const chatAgent = agent({
        sandbox: await createBashTool({
          sandbox: backend,
          workingDirectory: '/workspace',
        }),
        name: 'aborted-turn',
        context,
        model,
      });
      await context.continue(userMessage('go'));
      const controller = new AbortController();
      const reason = new Error('stop');

      const stream = await chat(chatAgent, { abortSignal: controller.signal });
      const consumed = Array.fromAsync(stream);
      await t.waitFor(
        async () =>
          assert.ok(await backend.stat({ path: '/workspace/started' })),
        { interval: 50, timeout: 30_000 },
      );
      controller.abort(reason);
      await assert.rejects(consumed, (error) => error === reason);

      await t.waitFor(
        async () =>
          assert.deepStrictEqual(
            await storedBashPart(store, 'aborted-turn').then(
              ({ state, errorText }) => ({ state, errorText }),
            ),
            { state: 'output-error', errorText: 'Cancelled by user' },
          ),
        { interval: 50, timeout: 10_000 },
      );
      assert.strictEqual(model.doStreamCalls.length, 1);

      await context.continue(userMessage('again'));
      await Array.fromAsync(await chat(chatAgent));
      await sleep(10_500);

      assert.deepStrictEqual(
        model.doStreamCalls[1]?.prompt
          .filter((message) => message.role === 'tool')
          .flatMap((message) => message.content)
          .map((part) => part.type === 'tool-result' && part.output),
        [{ type: 'error-text', value: 'Cancelled by user' }],
      );
      assert.strictEqual(await backend.stat({ path: '/workspace/late' }), null);
    });

    it('returns a timed-out result the model reads when a bash call passes its tool timeout, and stops the command', async () => {
      await using backend = await createDockerSandbox(defaults);
      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        store,
        chatId: 'tool-timeout',
        userId: 'user',
      });
      const model = bashThenText('echo partial; sleep 10; touch late');
      const chatAgent = agent({
        sandbox: await createBashTool({
          sandbox: backend,
          workingDirectory: '/workspace',
        }),
        name: 'tool-timeout',
        context,
        model,
        timeout: { tools: { bashMs: 1_500 } },
      });
      await context.continue(userMessage('go'));

      await Array.fromAsync(await chat(chatAgent));
      await sleep(10_500);

      const part = await storedBashPart(store, 'tool-timeout');
      assert.strictEqual(part.state, 'output-available');
      const { stdout, stderr, exitCode } = part.output as CommandResult;
      assert.deepStrictEqual(
        { stdout, exitCode },
        { stdout: '', exitCode: 124 },
      );
      const [, elapsed] =
        /^Command timed out after (\d+) ms$/.exec(stderr) ?? [];
      assert.ok(Number(elapsed) >= 1_500, stderr);
      assert.deepStrictEqual(
        model.doStreamCalls[1]?.prompt
          .filter((message) => message.role === 'tool')
          .flatMap((message) => message.content)
          .map((part) => part.type === 'tool-result' && part.output.type),
        ['json'],
      );
      assert.strictEqual(await backend.stat({ path: '/workspace/late' }), null);
    });

    it('ends the turn when the total timeout fires during a bash call, and stops the command', async () => {
      await using backend = await createDockerSandbox(defaults);
      const store = new InMemoryContextStore();
      const context = new ContextEngine({
        store,
        chatId: 'total-timeout',
        userId: 'user',
      });
      const model = bashThenText('sleep 10; touch late');
      const chatAgent = agent({
        sandbox: await createBashTool({
          sandbox: backend,
          workingDirectory: '/workspace',
        }),
        name: 'total-timeout',
        context,
        model,
        timeout: { totalMs: 1_500 },
      });
      await context.continue(userMessage('go'));

      await Array.fromAsync(await chat(chatAgent)).catch(() => undefined);
      await sleep(10_500);

      const { state, errorText } = await storedBashPart(store, 'total-timeout');
      assert.deepStrictEqual(
        { state, errorText },
        { state: 'output-error', errorText: 'Cancelled by user' },
      );
      assert.strictEqual(model.doStreamCalls.length, 1);
      assert.strictEqual(await backend.stat({ path: '/workspace/late' }), null);
    });

    it('fails an aborted bash call with the abort reason, stops the command, and skips onAfterBashCall', async (t) => {
      await using sandbox = await createDockerSandbox(defaults);
      const afterCalls: string[] = [];
      const { bash } = await createBashTool({
        sandbox,
        workingDirectory: '/workspace',
        onAfterBashCall: ({ command }) => {
          afterCalls.push(command);
        },
      });
      assert.ok(bash.execute);
      const controller = new AbortController();
      const reason = new Error('stop');

      const call = Promise.resolve(
        bash.execute(
          {
            command: 'touch started; sleep 10; touch late',
            reasoning: 'an aborted call',
          },
          {
            abortSignal: controller.signal,
            context: {},
            messages: [],
            toolCallId: 'aborted-call',
          },
        ),
      );
      await t.waitFor(
        async () =>
          assert.ok(await sandbox.stat({ path: '/workspace/started' })),
        { interval: 50, timeout: 30_000 },
      );
      controller.abort(reason);

      await assert.rejects(call, (error) => error === reason);
      await sleep(10_500);
      assert.strictEqual(await sandbox.stat({ path: '/workspace/late' }), null);
      assert.deepStrictEqual(afterCalls, []);
    });

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
