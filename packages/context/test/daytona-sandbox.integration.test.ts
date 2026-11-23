import type { Sandbox } from '@daytona/sdk/v2';
import { waitFor } from '@zukhruf/testing/async';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { text as streamText } from 'node:stream/consumers';
import { describe, it } from 'node:test';

import {
  type ChatSandbox,
  DaytonaSandboxEnvironment,
  type SandboxContext,
  type SandboxSession,
  createBashTool,
  createDaytonaSandbox,
} from '@deepagents/context';

import {
  every,
  everySessionOperation,
  outcomes,
  sessionOutcomes,
} from './helpers/chat-sandbox-outcomes.ts';
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

/** The Daytona sandbox behind a session, found by the id it carries inside. */
async function sandboxOf(session: SandboxSession): Promise<Sandbox> {
  const { stdout } = await session.run({
    command: 'printf %s "$DAYTONA_SANDBOX_ID"',
  });
  assert.ok(stdout, 'the sandbox knows its id');
  return live().get(stdout);
}

async function state(id: string): Promise<string> {
  return (await live().get(id)).state;
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
    it('deletes its sandbox by the time dispose resolves', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const { id } = await sandboxOf(sandbox);
      const whileOpen = await state(id);

      await sandbox.dispose();

      assert.deepStrictEqual(
        [whileOpen, await state(id)],
        ['started', 'destroyed'],
      );
    });

    it('rejects every operation with an error that names its sandbox once it is disposed, never with SandboxNotFoundError', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      const { id } = await sandboxOf(sandbox);

      await sandbox.dispose();

      assert.deepStrictEqual(
        await sessionOutcomes(sandbox),
        everySessionOperation(`Error: The sandbox "${id}" is disposed.`),
      );
    });

    it('rejects every operation with SandboxNotFoundError once its sandbox was deleted outside', async () => {
      await using sandbox = await createDaytonaSandbox(live());
      await live().delete((await sandboxOf(sandbox)).id);

      assert.deepStrictEqual(
        await sessionOutcomes(sandbox),
        everySessionOperation('SandboxNotFoundError'),
      );
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

function chat(chatId: string): SandboxContext {
  return { chatId, userId: 'user-1' };
}

/**
 * The chat sandboxes of one test, which it deletes when it ends: each one it
 * reached, and each one Daytona search lists under its namespace (search lags
 * a create by seconds, so it alone could miss one).
 */
class Chats implements AsyncDisposable {
  readonly namespace = `deepagents-test-${randomUUID()}`;
  readonly #reached = new Set<string>();

  environment(
    options: Omit<
      ConstructorParameters<typeof DaytonaSandboxEnvironment>[1],
      'namespace'
    > = {},
  ): DaytonaSandboxEnvironment {
    return new DaytonaSandboxEnvironment(live(), {
      ...options,
      namespace: this.namespace,
    });
  }

  /** The chat's sandbox, opened through `environment` and deleted when the test ends. */
  async open(
    environment: DaytonaSandboxEnvironment,
    chatId: string,
  ): Promise<ChatSandbox> {
    const handle = await environment.open(chat(chatId));
    await this.idOf(handle);
    return handle;
  }

  /** The id of the sandbox `handle` holds, deleted when the test ends. */
  async idOf(handle: ChatSandbox): Promise<string> {
    const { id } = await sandboxOf(handle);
    this.#reached.add(id);
    return id;
  }

  /** The ids Daytona search lists for the chat, by its labels. */
  async listed(chatId: string): Promise<string[]> {
    const { items } = await live().search({
      labels: {
        'deepagents.sandbox.namespace': this.namespace,
        'deepagents.sandbox.chat': chatId,
      },
    });
    return items.map(({ id }) => id);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const { items } = await live().search({
      labels: { 'deepagents.sandbox.namespace': this.namespace },
    });
    const ids = new Set([...this.#reached, ...items.map(({ id }) => id)]);
    await Promise.all([...ids].map((id) => live().delete(id)));
  }
}

describe('DaytonaSandboxEnvironment', { skip }, () => {
  it('opens one sandbox per chat that its handles and another environment share, found by its labels', async (t) => {
    await using chats = new Chats();
    await using first = await chats.open(chats.environment(), 'chat-1');
    const id = await chats.idOf(first);
    await first.writeTextFile({ path: '/tmp/marker', content: 'first' });

    await using second = await chats.open(chats.environment(), 'chat-1');
    await using other = await chats.open(chats.environment(), 'chat-1');

    assert.deepStrictEqual(
      [await chats.idOf(second), await chats.idOf(other)],
      [id, id],
    );
    assert.strictEqual(
      await other.readTextFile({ path: '/tmp/marker' }),
      'first',
    );
    await waitFor(
      async () => assert.deepStrictEqual(await chats.listed('chat-1'), [id]),
      { signal: t.signal },
    );
  });

  it('isolates chats from each other, and the same chat in another namespace', async () => {
    await using chats = new Chats();
    await using elsewhere = new Chats();
    await using one = await chats.open(chats.environment(), 'chat-1');
    await using two = await chats.open(chats.environment(), 'chat-2');
    await using sameChat = await elsewhere.open(
      elsewhere.environment(),
      'chat-1',
    );

    const ids = [
      await chats.idOf(one),
      await chats.idOf(two),
      await elsewhere.idOf(sameChat),
    ];

    assert.strictEqual(new Set(ids).size, 3);
  });

  it('closes a handle once and rejects its operations with an error that names the chat, leaving the sandbox running', async () => {
    await using chats = new Chats();
    const handle = await chats.open(chats.environment(), 'chat-1');
    const id = await chats.idOf(handle);

    await handle.close();
    await handle.close();
    await handle[Symbol.asyncDispose]();

    assert.deepStrictEqual(
      await outcomes(handle),
      every('Error: The sandbox handle of chat "chat-1" is closed.'),
    );
    assert.strictEqual(await state(id), 'started');
  });

  it('deletes the chat sandbox once search lists it, resolves when there is none, and the next open makes a new one', async (t) => {
    await using chats = new Chats();
    const environment = chats.environment();
    await using handle = await chats.open(environment, 'chat-1');
    const id = await chats.idOf(handle);
    await handle.writeTextFile({ path: '/tmp/marker', content: 'first' });
    await waitFor(
      async () => assert.deepStrictEqual(await chats.listed('chat-1'), [id]),
      { signal: t.signal },
    );

    await environment.delete(chat('chat-1'));
    await environment.delete(chat('chat-1'));
    await environment.delete(chat('never-opened'));

    assert.strictEqual(await state(id), 'destroyed');
    await using fresh = await chats.open(environment, 'chat-1');
    assert.notStrictEqual(await chats.idOf(fresh), id);
    assert.strictEqual(await fresh.readTextFile({ path: '/tmp/marker' }), null);
  });

  it('rejects every operation of a handle, resume included, with SandboxNotFoundError once its sandbox was deleted outside, also after the chat is opened again', async () => {
    await using chats = new Chats();
    const environment = chats.environment();
    await using handle = await chats.open(environment, 'chat-1');
    await live().delete(await chats.idOf(handle));

    const afterDelete = await outcomes(handle);
    await using reopened = await chats.open(environment, 'chat-1');
    const afterReopen = await outcomes(handle);

    assert.deepStrictEqual(afterDelete, every('SandboxNotFoundError'));
    assert.deepStrictEqual(afterReopen, every('SandboxNotFoundError'));
    await reopened.resume();
    assert.strictEqual(
      (await reopened.run({ command: 'echo up' })).stdout,
      'up\n',
    );
  });

  it('opens the existing sandbox, with its configuration, when the options changed since it was created', async (t) => {
    await using chats = new Chats();
    await using before = await chats.open(
      chats.environment({ env: { DEPLOY: 'first' }, labels: { app: 'first' } }),
      'chat-1',
    );
    const id = await chats.idOf(before);
    await waitFor(
      async () => assert.deepStrictEqual(await chats.listed('chat-1'), [id]),
      { signal: t.signal },
    );

    await using after = await chats.open(
      chats.environment({
        env: { DEPLOY: 'changed' },
        labels: { app: 'changed' },
      }),
      'chat-1',
    );

    assert.strictEqual(await chats.idOf(after), id);
    assert.strictEqual(
      (await after.run({ command: 'printf %s "$DEPLOY"' })).stdout,
      'first',
    );
    const { labels = {} } = await live().get(id);
    assert.deepStrictEqual(
      {
        app: labels['app'],
        namespace: labels['deepagents.sandbox.namespace'],
        chat: labels['deepagents.sandbox.chat'],
      },
      { app: 'first', namespace: chats.namespace, chat: 'chat-1' },
    );
  });

  it('runs readiness on every open, and a failed readiness rejects the open and leaves the sandbox', async () => {
    await using chats = new Chats();
    const ready: string[] = [];
    const environment = chats.environment({
      readiness: async (sandbox) => {
        ready.push((await sandbox.run({ command: 'echo ready' })).stdout);
      },
    });
    await using handle = await chats.open(environment, 'chat-1');
    const id = await chats.idOf(handle);
    await using again = await chats.open(environment, 'chat-1');
    const failure = new Error('not ready');

    await assert.rejects(
      chats
        .environment({
          readiness: () => {
            throw failure;
          },
        })
        .open(chat('chat-1')),
      (error) => error === failure,
    );

    assert.deepStrictEqual(ready, ['ready\n', 'ready\n']);
    assert.strictEqual(await chats.idOf(again), id);
    assert.strictEqual(await state(id), 'started');
  });
});
