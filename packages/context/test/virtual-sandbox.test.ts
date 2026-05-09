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
});
