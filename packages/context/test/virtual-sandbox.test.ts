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
