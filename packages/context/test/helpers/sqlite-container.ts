import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SqliteContextStore } from '@deepagents/context';

/**
 * Helper to run a test function with a temporary SQLite database.
 * Automatically handles setup and cleanup.
 *
 * Note: SQLite is filesystem-based (no Docker container needed).
 * The function name follows the with*Container pattern for consistency
 * with withPostgresContainer and withSqlServerContainer.
 *
 * @example
 * ```typescript
 * await withSqliteContainer(async (store) => {
 *   const engine = new ContextEngine({ store, chatId: 'test', userId: 'user' });
 *   // ... run tests
 * });
 * ```
 */
export async function withSqliteContainer<T>(
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
