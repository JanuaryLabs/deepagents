import { DatabaseSync } from 'node:sqlite';
import { v7 } from 'uuid';

import {
  type GeneratedTeachable,
  type Teachables,
  toTeachables,
} from '../teach/teachables.ts';
import storeDDL from './store.sqlite.sql';
import { type StoredTeachable, TeachablesStore } from './store.ts';

interface TeachableRow {
  id: string;
  userId: string;
  type: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

function rowToStoredTeachable(row: TeachableRow): StoredTeachable {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as GeneratedTeachable['type'],
    data: JSON.parse(row.data),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteTeachablesStore extends TeachablesStore {
  #db: DatabaseSync;

  constructor(path: string) {
    super();
    this.#db = new DatabaseSync(path);
    this.#db.exec(storeDDL);
  }

  async remember(
    userId: string,
    data: GeneratedTeachable,
  ): Promise<StoredTeachable> {
    const id = v7();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        'INSERT INTO teachables (id, userId, type, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, data.type, JSON.stringify(data), now, now);

    return (await this.get(id))!;
  }

  async recall(
    userId: string,
    type?: GeneratedTeachable['type'],
  ): Promise<StoredTeachable[]> {
    let rows: TeachableRow[];

    if (type === undefined) {
      rows = this.#db
        .prepare('SELECT * FROM teachables WHERE userId = ? ORDER BY createdAt')
        .all(userId) as unknown as TeachableRow[];
    } else {
      rows = this.#db
        .prepare(
          'SELECT * FROM teachables WHERE userId = ? AND type = ? ORDER BY createdAt',
        )
        .all(userId, type) as unknown as TeachableRow[];
    }

    return rows.map(rowToStoredTeachable);
  }

  async get(id: string): Promise<StoredTeachable | null> {
    const row = this.#db
      .prepare('SELECT * FROM teachables WHERE id = ?')
      .get(id) as TeachableRow | undefined;

    if (!row) return null;
    return rowToStoredTeachable(row);
  }

  async update(id: string, data: GeneratedTeachable): Promise<StoredTeachable> {
    const now = new Date().toISOString();

    this.#db
      .prepare(
        'UPDATE teachables SET data = ?, type = ?, updatedAt = ? WHERE id = ?',
      )
      .run(JSON.stringify(data), data.type, now, id);

    return (await this.get(id))!;
  }

  async forget(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM teachables WHERE id = ?').run(id);
  }

  async forgetAll(userId: string): Promise<void> {
    this.#db.prepare('DELETE FROM teachables WHERE userId = ?').run(userId);
  }

  async toTeachables(userId: string): Promise<Teachables[]> {
    const stored = await this.recall(userId);
    return toTeachables(stored.map((s) => s.data));
  }
}
