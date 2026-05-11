import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildSandbox } from './helpers/build-sandbox.ts';

type BuiltSandbox = Awaited<ReturnType<typeof buildSandbox>>;
const drainEvents = (sandbox: BuiltSandbox) => sandbox.drainFileEvents();

describe('sandbox file-event tracking', () => {
  it('records a write event for sandbox.writeFiles on a new path', async () => {
    const sandbox = await buildSandbox();
    await sandbox.sandbox.writeFiles([
      { path: '/sql/result.json', content: '[{"n":1}]' },
    ]);

    const events = drainEvents(sandbox);
    const writes = events.filter((e) => e.op === 'write');
    assert.ok(
      writes.some((e) => e.path === '/sql/result.json'),
      `expected write for /sql/result.json, got ${JSON.stringify(events)}`,
    );
  });

  it('distinguishes write vs modify on overwrite', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([{ path: '/tmp/a.txt', content: 'one' }]);
    await sandbox.sandbox.writeFiles([{ path: '/tmp/a.txt', content: 'two' }]);

    const events = drainEvents(sandbox);
    const aTxt = events.filter((e) => e.path === '/tmp/a.txt');
    assert.deepStrictEqual(
      aTxt.map((e) => e.op),
      ['write', 'modify'],
    );
  });

  it('records a read event for sandbox.readFile', async () => {
    const sandbox = await buildSandbox();
    await sandbox.sandbox.writeFiles([{ path: '/tmp/r.txt', content: 'hi' }]);
    drainEvents(sandbox);

    const content = await sandbox.sandbox.readFile('/tmp/r.txt');
    assert.strictEqual(content, 'hi');

    const events = drainEvents(sandbox);
    assert.deepStrictEqual(
      events.map((e) => ({ path: e.path, op: e.op })),
      [{ path: '/tmp/r.txt', op: 'read' }],
    );
  });

  it('drains events and clears the buffer', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([{ path: '/tmp/x', content: 'x' }]);
    assert.strictEqual(drainEvents(sandbox).length, 1);
    assert.strictEqual(drainEvents(sandbox).length, 0);
  });

  it('tracks rm as delete', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([{ path: '/tmp/y', content: 'y' }]);
    drainEvents(sandbox);

    const rm = await sandbox.sandbox.executeCommand('rm /tmp/y');
    assert.strictEqual(rm.exitCode, 0, rm.stderr);

    const events = drainEvents(sandbox);
    assert.deepStrictEqual(
      events.map((e) => ({ path: e.path, op: e.op })),
      [{ path: '/tmp/y', op: 'delete' }],
    );
  });

  it('emits no events when a command does not touch the filesystem', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([{ path: '/d/a.txt', content: 'a' }]);
    drainEvents(sandbox);

    const ls = await sandbox.sandbox.executeCommand('ls /d');
    assert.strictEqual(ls.exitCode, 0, ls.stderr);
    assert.ok(ls.stdout.includes('a.txt'));

    assert.deepStrictEqual(drainEvents(sandbox), []);
  });

  it('emits no events when rm -f targets a nonexistent path', async () => {
    const sandbox = await buildSandbox();

    const rm = await sandbox.sandbox.executeCommand('rm -f /tmp/missing.txt');
    assert.strictEqual(rm.exitCode, 0, rm.stderr);

    assert.deepStrictEqual(drainEvents(sandbox), []);
  });

  it('emits a write event per file for recursive cp', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([
      { path: '/src/a.txt', content: 'a' },
      { path: '/src/sub/b.txt', content: 'b' },
    ]);
    drainEvents(sandbox);

    const cp = await sandbox.sandbox.executeCommand('cp -r /src /dst');
    assert.strictEqual(cp.exitCode, 0, cp.stderr);

    const written = drainEvents(sandbox)
      .filter((e) => e.op === 'write')
      .map((e) => e.path)
      .sort();
    assert.deepStrictEqual(written, ['/dst/a.txt', '/dst/sub/b.txt']);
  });

  it('emits a delete event per file for recursive rm', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([
      { path: '/tree/a.txt', content: 'a' },
      { path: '/tree/b.txt', content: 'b' },
      { path: '/tree/sub/c.txt', content: 'c' },
    ]);
    drainEvents(sandbox);

    const rm = await sandbox.sandbox.executeCommand('rm -rf /tree');
    assert.strictEqual(rm.exitCode, 0, rm.stderr);

    const deleted = drainEvents(sandbox)
      .filter((e) => e.op === 'delete')
      .map((e) => e.path)
      .sort();
    assert.deepStrictEqual(deleted, [
      '/tree/a.txt',
      '/tree/b.txt',
      '/tree/sub/c.txt',
    ]);
  });

  it('still records the file event when the command exits nonzero', async () => {
    const sandbox = await buildSandbox();

    const r = await sandbox.sandbox.executeCommand(
      `sh -c 'echo hi > /tmp/touched.txt; exit 7'`,
    );
    assert.strictEqual(r.exitCode, 7);

    const events = drainEvents(sandbox);
    assert.ok(
      events.some((e) => e.path === '/tmp/touched.txt' && e.op === 'write'),
      `expected write for /tmp/touched.txt despite nonzero exit, got ${JSON.stringify(events)}`,
    );
  });
});
