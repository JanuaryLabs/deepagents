import { SqliteContextStore } from './sqlite.store.ts';

/**
 * In-memory context store.
 *
 * Uses SQLite's :memory: database for non-persistent storage.
 * Useful for testing and short-lived sessions.
 */
export class InMemoryContextStore extends SqliteContextStore {
  constructor() {
    super(':memory:');
  }
}
