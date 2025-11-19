import { SqliteHistory } from './sqlite.history.ts';

export class InMemoryHistory extends SqliteHistory {
  constructor() {
    super(':memory:');
  }
}
