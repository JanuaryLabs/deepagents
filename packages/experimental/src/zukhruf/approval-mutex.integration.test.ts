import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteApprovalMutex } from '@deepagents/experimental/zukhruf';

test('independent processes cannot enter the same SQLite approval mutex concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zukhruf-approval-mutex-'));
  const databasePath = join(directory, 'approvals.sqlite');
  const markerPath = join(directory, 'released');
  using mutex = new SqliteApprovalMutex(databasePath);
  const holder = fork(
    new URL('./approval-mutex.fixture.ts', import.meta.url),
    [databasePath, markerPath],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );

  try {
    const [message] = (await once(holder, 'message')) as [{ type: string }];
    assert.equal(message.type, 'locked');

    await mutex.runExclusive('fixture-chat', async () => {
      assert.equal(
        existsSync(markerPath),
        true,
        'the holder completed its protected operation before this process entered',
      );
    });
    await once(holder, 'exit');
  } finally {
    holder.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
