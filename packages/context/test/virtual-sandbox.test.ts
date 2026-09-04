import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createVirtualSandbox } from '@deepagents/context';

describe('createVirtualSandbox', () => {
  it('executes normal bash commands directly', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });

    const result = await sandbox.executeCommand('echo hello');

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, 'hello\n');
  });

  it('reads and writes files through the virtual filesystem', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });

    await sandbox.writeFiles([{ path: '/tmp/a.txt', content: 'one' }]);
    const content = await sandbox.readFile('/tmp/a.txt');

    assert.strictEqual(content, 'one');
  });

  it('round-trips bytes that are not valid UTF-8 when reading as binary', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0xff]);

    await sandbox.writeFiles([{ path: '/tmp/blob.bin', content: bytes }]);
    const content = await sandbox.readFile('/tmp/blob.bin', {
      encoding: 'binary',
    });

    assert.ok(content instanceof Uint8Array);
    assert.deepStrictEqual(Array.from(content), [0x89, 0x50, 0x00, 0xff]);
  });

  it('reads text as a string by default and with an explicit utf-8 encoding', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    await sandbox.writeFiles([{ path: '/tmp/text.txt', content: 'héllo' }]);

    const implicit = await sandbox.readFile('/tmp/text.txt');
    const explicit = await sandbox.readFile('/tmp/text.txt', {
      encoding: 'utf-8',
    });

    assert.strictEqual(typeof implicit, 'string');
    assert.strictEqual(implicit, 'héllo');
    assert.strictEqual(explicit, 'héllo');
  });

  it('reports whether a file or directory exists', async () => {
    const sandbox = await createVirtualSandbox({ fs: new InMemoryFs() });
    await sandbox.writeFiles([{ path: '/tmp/present/a.txt', content: 'one' }]);

    assert.strictEqual(await sandbox.exists('/tmp/present/a.txt'), true);
    assert.strictEqual(await sandbox.exists('/tmp/present'), true);
    assert.strictEqual(await sandbox.exists('/tmp/missing.txt'), false);
  });

  it('honors cwd and env options', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      cwd: '/workspace',
      env: { FLAG: 'ok' },
    });
    await sandbox.executeCommand('mkdir -p /workspace');

    const result = await sandbox.executeCommand('pwd && echo "$FLAG"');

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout, '/workspace\nok\n');
  });

  it('enables JavaScript when requested', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      javascript: true,
    });

    const result = await sandbox.executeCommand('js-exec --version');

    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /^QuickJS /);
  });

  it('runs the readiness hook against the sandbox before returning it', async () => {
    const sandbox = await createVirtualSandbox({
      fs: new InMemoryFs(),
      readiness: async (booting) => {
        await booting.writeFiles([
          { path: '/tmp/readiness-ran.txt', content: 'ok' },
        ]);
      },
    });

    assert.strictEqual(await sandbox.readFile('/tmp/readiness-ran.txt'), 'ok');
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
