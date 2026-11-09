import { InMemoryFs, defineCommand } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createVirtualSandbox } from '@deepagents/context';

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
