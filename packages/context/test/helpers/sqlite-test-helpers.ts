import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteContextStore } from '@deepagents/context';

export async function withTempDb<T>(
  fn: (store: SqliteContextStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const store = new SqliteContextStore(dbPath);
  try {
    return await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
