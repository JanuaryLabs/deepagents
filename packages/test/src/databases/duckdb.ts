import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

export interface DuckDBDatabase extends AsyncDisposable {
  connection: DuckDBConnection;
  /** Close the connection before releasing its in-memory database instance. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns an independent, in-memory DuckDB database. */
export class DuckDB {
  async database(): Promise<DuckDBDatabase> {
    await using resources = new AsyncDisposableStack();
    const instance = resources.adopt(
      await DuckDBInstance.create(),
      (instance) => instance.closeSync(),
    );
    const connection = resources.adopt(await instance.connect(), (connection) =>
      connection.closeSync(),
    );
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return { connection, cleanup, [Symbol.asyncDispose]: cleanup };
  }
}
