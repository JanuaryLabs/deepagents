import { SqliteTeachablesStore } from './sqlite.store.ts';

export class InMemoryTeachablesStore extends SqliteTeachablesStore {
  constructor() {
    super(':memory:');
  }
}
