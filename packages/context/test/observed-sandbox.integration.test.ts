import { InMemoryFs } from 'just-bash';
import spawn from 'nano-spawn';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  createBashTool,
  createContainerTool,
  createVirtualSandbox,
  observeSandboxFileEvents,
} from '@deepagents/context';

async function isDockerAvailable(): Promise<boolean> {
  try {
    await spawn('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

describe('observeSandboxFileEvents (virtual sandbox)', () => {
  it('defaults the destination to /workspace when caller omits it', async () => {
    const sandbox = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    });
    await sandbox.sandbox.writeFiles([
      { path: '/workspace/seed.txt', content: 'x' },
    ]);

    const events = sandbox.drainFileEvents();
    assert.ok(
      events.some((e) => e.path === '/workspace/seed.txt' && e.op === 'write'),
      `expected write under /workspace, got ${JSON.stringify(events)}`,
    );
  });

  it('treats a not-yet-created destination as an empty snapshot', async () => {
    const underlying = await createVirtualSandbox({ fs: new InMemoryFs() });
    const { sandbox, drain } = observeSandboxFileEvents(underlying, {
      destination: '/not-yet',
    });

    const r = await sandbox.executeCommand('true');
    assert.strictEqual(r.exitCode, 0);
    assert.deepStrictEqual(drain(), []);
  });

  it('throws when constructed without a destination', async () => {
    const underlying = await createVirtualSandbox({ fs: new InMemoryFs() });
    assert.throws(
      () => observeSandboxFileEvents(underlying, { destination: '' }),
      /destination is required/,
    );
  });

  it('records read events for sandbox.readFile only (not for cat)', async () => {
    const built = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      destination: '/',
    });

    await built.sandbox.writeFiles([{ path: '/tmp/r.txt', content: 'hi' }]);
    built.drainFileEvents();

    const cat = await built.sandbox.executeCommand('cat /tmp/r.txt');
    assert.strictEqual(cat.exitCode, 0);
    assert.deepStrictEqual(built.drainFileEvents(), []);

    await built.sandbox.readFile('/tmp/r.txt');
    const events = built.drainFileEvents();
    assert.deepStrictEqual(
      events.map((e) => ({ path: e.path, op: e.op })),
      [{ path: '/tmp/r.txt', op: 'read' }],
    );
  });

  it('emits no phantom events when writing to a previously-empty destination', async () => {
    const built = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      destination: '/',
    });

    await built.sandbox.writeFiles([{ path: '/first.txt', content: 'first' }]);

    const events = built.drainFileEvents();
    assert.deepStrictEqual(
      events.map((e) => ({ path: e.path, op: e.op })),
      [{ path: '/first.txt', op: 'write' }],
    );
  });

  it('records a write event even when the command exits nonzero', async () => {
    const built = await createBashTool({
      sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
      destination: '/',
    });

    const r = await built.sandbox.executeCommand(
      `sh -c 'echo hi > /tmp/x.txt; exit 9'`,
    );
    assert.strictEqual(r.exitCode, 9);

    const events = built.drainFileEvents();
    assert.ok(
      events.some((e) => e.path === '/tmp/x.txt' && e.op === 'write'),
      `expected /tmp/x.txt write despite exit 9, got ${JSON.stringify(events)}`,
    );
  });
});

const dockerAvailable = await isDockerAvailable();
const dockerSuite = dockerAvailable ? describe : describe.skip;

dockerSuite('observeSandboxFileEvents (docker backend)', () => {
  const ROOT = `/tmp/observer-${process.pid}`;
  const FILE = `${ROOT}/file.txt`;

  async function withSandbox<T>(
    fn: (s: Awaited<ReturnType<typeof createContainerTool>>) => Promise<T>,
  ): Promise<T> {
    const s = await createContainerTool({
      image: 'alpine:latest',
      destination: ROOT,
    });
    try {
      await s.sandbox.executeCommand(`mkdir -p ${ROOT}`);
      return await fn(s);
    } finally {
      await s.sandbox.dispose();
    }
  }

  it('records a write event from a shell command', async () => {
    await withSandbox(async (s) => {
      const r = await s.sandbox.executeCommand(`sh -c 'echo first > ${FILE}'`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      const events = s.drainFileEvents();
      assert.ok(
        events.some((e) => e.path === FILE && e.op === 'write'),
        `expected write, got ${JSON.stringify(events)}`,
      );
    });
  });

  it('records a modify event on overwrite', async () => {
    await withSandbox(async (s) => {
      await s.sandbox.executeCommand(`sh -c 'echo first > ${FILE}'`);
      s.drainFileEvents();
      const r = await s.sandbox.executeCommand(`sh -c 'echo second > ${FILE}'`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      const events = s.drainFileEvents();
      assert.ok(
        events.some((e) => e.path === FILE && e.op === 'modify'),
        `expected modify, got ${JSON.stringify(events)}`,
      );
    });
  });

  it('records a delete event on rm', async () => {
    await withSandbox(async (s) => {
      await s.sandbox.executeCommand(`sh -c 'echo first > ${FILE}'`);
      s.drainFileEvents();
      const r = await s.sandbox.executeCommand(`rm ${FILE}`);
      assert.strictEqual(r.exitCode, 0, r.stderr);
      const events = s.drainFileEvents();
      assert.ok(
        events.some((e) => e.path === FILE && e.op === 'delete'),
        `expected delete, got ${JSON.stringify(events)}`,
      );
    });
  });
});
