import { InMemoryFs, defineCommand } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  SandboxNotFoundError,
  VirtualSandboxEnvironment,
  createVirtualSandbox,
} from '@deepagents/context';

import { every, outcomes } from './helpers/chat-sandbox-outcomes.ts';

describe('createVirtualSandbox', () => {
  it('executes normal bash commands directly', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });

    const result = await sandbox.run({ command: 'echo hello' });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('reads and writes files through the virtual filesystem', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });

    await sandbox.writeTextFile({ path: '/tmp/a.txt', content: 'one' });
    const content = await sandbox.readTextFile({ path: '/tmp/a.txt' });

    assert.strictEqual(content, 'one');
  });

  it('round-trips bytes that are not valid UTF-8 when reading as binary', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);

    await sandbox.writeBinaryFile({ path: '/tmp/blob.bin', content: bytes });
    const content = await sandbox.readBinaryFile({ path: '/tmp/blob.bin' });

    assert.ok(content instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(content), [0x89, 0x50, 0x00, 0xff]);
  });

  it('reads text as a string by default and with an explicit utf-8 encoding', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    await sandbox.writeTextFile({ path: '/tmp/text.txt', content: 'héllo' });

    const implicit = await sandbox.readTextFile({ path: '/tmp/text.txt' });
    const explicit = await sandbox.readTextFile({
      path: '/tmp/text.txt',
      encoding: 'utf-8',
    });

    assert.strictEqual(typeof implicit, 'string');
    assert.strictEqual(implicit, 'héllo');
    assert.strictEqual(explicit, 'héllo');
  });

  it('reports whether a file or directory exists', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    await sandbox.writeTextFile({ path: '/tmp/present/a.txt', content: 'one' });

    assert.strictEqual(
      (await sandbox.stat({ path: '/tmp/present/a.txt' })) !== null,
      true,
    );
    assert.strictEqual(
      (await sandbox.stat({ path: '/tmp/present' })) !== null,
      true,
    );
    assert.strictEqual(
      (await sandbox.stat({ path: '/tmp/missing.txt' })) !== null,
      false,
    );
  });

  it('honors cwd and env options', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      cwd: '/workspace',
      env: { FLAG: 'ok' },
    });
    await sandbox.run({ command: 'mkdir -p /workspace' });

    const result = await sandbox.run({ command: 'pwd && echo "$FLAG"' });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, '/workspace\nok\n');
  });

  it('enables JavaScript when requested', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      javascript: true,
    });

    const result = await sandbox.run({ command: 'js-exec --version' });

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^QuickJS /);
  });

  it('runs custom commands, including inside a pipeline', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      customCommands: [
        defineCommand('sql', async (args) => ({
          stdout: `sql:${args.join(',')}\n`,
          stderr: '',
          exitCode: 0,
        })),
      ],
    });

    const direct = await sandbox.run({ command: 'sql run "a b"' });
    const piped = await sandbox.run({ command: 'sql run | tr a-z A-Z' });

    assert.strictEqual(direct.stdout, 'sql:run,a b\n');
    assert.strictEqual(piped.stdout, 'SQL:RUN\n');
  });

  it('shares one filesystem with the caller, in both directions', async () => {
    const fs = new InMemoryFs();
    const sandbox = await createVirtualSandbox({ fs });

    await sandbox.run({ command: 'echo from-command > /tmp/command.txt' });
    await fs.writeFile('/tmp/caller.txt', 'from-caller');

    assert.strictEqual(await fs.readFile('/tmp/command.txt'), 'from-command\n');
    assert.strictEqual(
      await sandbox.readTextFile({ path: '/tmp/caller.txt' }),
      'from-caller',
    );
  });

  it('runs the readiness hook against the sandbox before returning it', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      readiness: async (booting) => {
        await booting.writeTextFile({
          path: '/tmp/readiness-ran.txt',
          content: 'ok',
        });
      },
    });

    assert.strictEqual(
      await sandbox.readTextFile({ path: '/tmp/readiness-ran.txt' }),
      'ok',
    );
  });

  it('rejects with the readiness error when the hook fails', async () => {
    await assert.rejects(
      createVirtualSandbox({
        fs: new InMemoryFs(),
        readiness: () => {
          throw new Error('service never came up');
        },
      }),
      /service never came up/,
    );
  });
});

describe('VirtualSandboxEnvironment', () => {
  it('rejects resume on a handle whose chat sandbox was deleted, also after the chat is opened again', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    await using held = await environment.open(chat);

    await environment.delete(chat);
    await assert.rejects(held.resume(), SandboxNotFoundError);
    await using reopened = await environment.open(chat);

    await assert.rejects(held.resume(), SandboxNotFoundError);
    await reopened.resume();
  });

  it('resolves delete of a chat that has no sandbox, however often it is called', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };

    await environment.delete(chat);
    await environment.delete(chat);

    await using sandbox = await environment.open(chat);
    assert.strictEqual(
      (await sandbox.run({ command: 'echo ok' })).stdout,
      'ok\n',
    );
  });

  it('gives a second open of the same chat the same sandbox', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    await using first = await environment.open(chat);
    await using second = await environment.open(chat);

    await first.run({ command: 'echo from-first > /tmp/shared.txt' });

    assert.strictEqual(
      await second.readTextFile({ path: '/tmp/shared.txt' }),
      'from-first\n',
    );
  });

  it('keys the sandbox by the chat, so another user of the same chat opens the same sandbox', async () => {
    const environment = new VirtualSandboxEnvironment();
    await using first = await environment.open({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    await using second = await environment.open({
      chatId: 'chat-1',
      userId: 'user-2',
    });

    await first.writeTextFile({ path: '/tmp/shared.txt', content: 'shared' });

    assert.strictEqual(
      await second.readTextFile({ path: '/tmp/shared.txt' }),
      'shared',
    );
  });

  it('keeps each chat in its own sandbox', async () => {
    const environment = new VirtualSandboxEnvironment();
    await using one = await environment.open({ chatId: 'one', userId: 'u' });
    await using other = await environment.open({
      chatId: 'other',
      userId: 'u',
    });

    await one.writeTextFile({ path: '/tmp/a.txt', content: 'one' });

    assert.strictEqual(await other.stat({ path: '/tmp/a.txt' }), null);
  });

  it('keeps the chat files when a handle closes', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    const first = await environment.open(chat);
    await first.writeTextFile({ path: '/tmp/kept.txt', content: 'kept' });

    await first.close();

    await using next = await environment.open(chat);
    assert.strictEqual(
      await next.readTextFile({ path: '/tmp/kept.txt' }),
      'kept',
    );
  });

  it('removes the chat files on delete, so the next open is fresh', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    await using before = await environment.open(chat);
    await before.writeTextFile({ path: '/tmp/gone.txt', content: 'gone' });

    await environment.delete(chat);

    await using after = await environment.open(chat);
    assert.strictEqual(await after.stat({ path: '/tmp/gone.txt' }), null);
  });

  it('rejects every operation of a handle opened before its chat sandbox was deleted', async () => {
    const environment = new VirtualSandboxEnvironment();
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    await using held = await environment.open(chat);
    await held.writeTextFile({ path: '/tmp/a.txt', content: 'a' });

    await environment.delete(chat);

    assert.deepStrictEqual(await outcomes(held), every('SandboxNotFoundError'));
  });

  it('rejects run on a closed handle as closed, not as a gone sandbox, and resolves a second close and the scope exit', async () => {
    const environment = new VirtualSandboxEnvironment();
    await using sandbox = await environment.open({
      chatId: 'chat-1',
      userId: 'user-1',
    });

    await sandbox.close();
    await sandbox.close();

    await assert.rejects(async () => sandbox.run({ command: 'echo hi' }), {
      name: 'Error',
      message: 'The sandbox handle of chat "chat-1" is closed.',
    });
  });

  it('runs the readiness hook on every open, and runs it again after a failed open', async () => {
    const chat = { chatId: 'chat-1', userId: 'user-1' };
    const calls: string[] = [];
    const environment = new VirtualSandboxEnvironment({
      readiness: async (sandbox) => {
        calls.push((await sandbox.run({ command: 'echo ready' })).stdout);
        if (calls.length === 1) throw new Error('not ready');
      },
    });

    const failed = await environment.open(chat).then(
      () => 'opened',
      (error: Error) => error.message,
    );
    await using opened = await environment.open(chat);
    await using again = await environment.open(chat);

    assert.deepStrictEqual(
      { failed, calls },
      {
        failed: 'not ready',
        calls: ['ready\n', 'ready\n', 'ready\n'],
      },
    );
  });
});
