import spawn, { SubprocessError } from 'nano-spawn';
import { once } from 'node:events';
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
  /** Holds a write lock in another process, which releases even while the caller blocks. */
  async writeLock(path: string, durationMs: number): Promise<AsyncDisposable> {
    const holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { DatabaseSync } from 'node:sqlite';
          import { setTimeout } from 'node:timers/promises';

          process.once('disconnect', () => process.exit(0));
          using database = new DatabaseSync(process.argv[1]);
          database.exec('BEGIN IMMEDIATE');
          process.send('locked');
          await setTimeout(Number(process.argv[2]));
          database.exec('ROLLBACK');
          process.disconnect();
        `,
        path,
        String(durationMs),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const exited = holder.then(() => {
      throw new Error('SQLite lock holder exited before acquiring the lock.');
    });
    const child = await Promise.race([holder.nodeChildProcess, exited]);
    try {
      await Promise.race([once(child, 'message'), exited]);
    } catch (error) {
      child.kill();
      await Promise.allSettled([holder]);
      throw error;
    }

    const resources = new AsyncDisposableStack();
    resources.defer(async () => {
      const killed = child.kill();
      try {
        await holder;
      } catch (error) {
        if (
          !killed ||
          !(error instanceof SubprocessError) ||
          error.signalName !== 'SIGTERM'
        )
          throw error;
      }
    });
    return resources;
  }

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
