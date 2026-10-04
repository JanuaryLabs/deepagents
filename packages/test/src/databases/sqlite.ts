import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteDatabase extends AsyncDisposable {
  path: string;
  connection: DatabaseSync;
  /** Close the connection before removing its temporary directory. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an independent, temporary SQLite database. */
export class Sqlite {
  async database(): Promise<SqliteDatabase> {
    await using resources = new AsyncDisposableStack();
    const directory = resources.use(
      await mkdtempDisposable(join(tmpdir(), 'deepagents-sqlite-')),
    );
    const path = join(directory.path, 'test.sqlite');
    const connection = resources.use(new DatabaseSync(path));
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { path, connection, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
