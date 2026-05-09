import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildSandbox } from './helpers/build-sandbox.ts';

type BuiltSandbox = Awaited<ReturnType<typeof buildSandbox>>;
const drainEvents = (sandbox: BuiltSandbox) => sandbox.drainFileEvents();

describe('virtual sandbox file-event tracking', () => {
  it('records a write event for sandbox result artifacts', async () => {
    const sandbox = await buildSandbox();
    await sandbox.sandbox.writeFiles([
      { path: '/sql/result.json', content: '[{"n":1}]' },
    ]);

    const events = drainEvents(sandbox) ?? [];
    const writes = events.filter((e) => e.op === 'write');
    assert.ok(
      writes.some((e) => e.path === '/sql/result.json'),
      `expected a write event under /sql/*.json, got ${JSON.stringify(events)}`,
    );
  });

  it('distinguishes write vs modify for an overwritten file', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([{ path: '/tmp/a.txt', content: 'one' }]);
    await sandbox.sandbox.writeFiles([{ path: '/tmp/a.txt', content: 'two' }]);

    const events = drainEvents(sandbox) ?? [];
    const aTxt = events.filter((e) => e.path === '/tmp/a.txt');
    assert.deepStrictEqual(
      aTxt.map((e) => e.op),
      ['write', 'modify'],
      'first write then modify on overwrite',
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

    const events = drainEvents(sandbox) ?? [];
    assert.ok(
      events.some((e) => e.path === '/tmp/y' && e.op === 'delete'),
      `expected delete event for /tmp/y, got ${JSON.stringify(events)}`,
    );
  });

  it('ls of a directory with files works (readdirWithFileTypes passthrough)', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([
      { path: '/d/a.txt', content: 'a' },
      { path: '/d/b.txt', content: 'b' },
    ]);

    const ls = await sandbox.sandbox.executeCommand('ls /d');
    assert.strictEqual(ls.exitCode, 0, ls.stderr);
    assert.ok(ls.stdout.includes('a.txt'));
    assert.ok(ls.stdout.includes('b.txt'));
  });

  it('emits no delete event when rm -f targets a nonexistent path', async () => {
    const sandbox = await buildSandbox();

    const rm = await sandbox.sandbox.executeCommand('rm -f /nope/missing.txt');
    assert.strictEqual(rm.exitCode, 0, rm.stderr);

    const events = drainEvents(sandbox) ?? [];
    assert.strictEqual(
      events.length,
      0,
      `expected no events for force-rm on nonexistent path, got ${JSON.stringify(events)}`,
    );
  });

  it('emits a write event per file for recursive cp of a directory', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([
      { path: '/src/a.txt', content: 'a' },
      { path: '/src/sub/b.txt', content: 'b' },
    ]);
    drainEvents(sandbox);

    const cp = await sandbox.sandbox.executeCommand('cp -r /src /dst');
    assert.strictEqual(cp.exitCode, 0, cp.stderr);

    const events = drainEvents(sandbox) ?? [];
    const writtenPaths = events
      .filter((e) => e.op === 'write')
      .map((e) => e.path)
      .sort();
    assert.ok(
      writtenPaths.includes('/dst/a.txt') &&
        writtenPaths.includes('/dst/sub/b.txt'),
      `expected per-file write events for recursive cp, got ${JSON.stringify(events)}`,
    );
  });

  it('emits a delete event per file for recursive rm of a directory', async () => {
    const sandbox = await buildSandbox();

    await sandbox.sandbox.writeFiles([
      { path: '/tree/a.txt', content: 'a' },
      { path: '/tree/b.txt', content: 'b' },
      { path: '/tree/sub/c.txt', content: 'c' },
    ]);
    drainEvents(sandbox);

    const rm = await sandbox.sandbox.executeCommand('rm -rf /tree');
    assert.strictEqual(rm.exitCode, 0, rm.stderr);

    const events = drainEvents(sandbox) ?? [];
    const deletedPaths = events
      .filter((e) => e.op === 'delete')
      .map((e) => e.path)
      .sort();
    assert.deepStrictEqual(
      deletedPaths,
      ['/tree', '/tree/a.txt', '/tree/b.txt', '/tree/sub/c.txt'],
      `expected per-file delete events for recursive rm, got ${JSON.stringify(events)}`,
    );
  });
});
