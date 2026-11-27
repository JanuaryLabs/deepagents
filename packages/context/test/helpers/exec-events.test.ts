import { DockerTestbed } from '@zukhruf/testing/docker';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import { createDockerSandbox } from '@deepagents/context';

import { execEvents, execsOf } from './exec-events.ts';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = { container: await testbed.defaults() };

describe('execsOf', () => {
  it('ends each marked exec at its own exec_die', async (t) => {
    await using sandbox = await createDockerSandbox(defaults);
    const events = await execEvents(testbed, sandbox, t.signal);
    try {
      const [a, b] = execsOf(events, 'a-done', 'b-done');

      const runA = sandbox.run({ command: 'echo a > /tmp/a-done' });
      await a.started;
      const runB = sandbox.run({ command: 'sleep 1; echo b > /tmp/b-done' });

      assert.strictEqual(await b.ended, '0');
      assert.strictEqual(
        await sandbox.readTextFile({ path: '/tmp/b-done' }),
        'b\n',
      );
      assert.strictEqual(await a.ended, '0');
      await Promise.all([runA, runB]);
    } finally {
      events.destroy();
    }
  });
});
