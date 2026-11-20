import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * A connection that dies mid-transaction emits the same error it rejects the
 * pending queries with. pg-pool listens only on idle clients, so without this
 * listener the event would crash the process; the queries still surface it.
 */
function surfacedThroughQueries(): void {}

function classNotLoaded(): never {
  throw new Error('PostgresTransaction: the class has not loaded');
}

const bridge: {
  open: (client: PoolClient) => PostgresTransaction;
  finish: (tx: PostgresTransaction) => void;
  openSavepoint: (parent: PostgresTransaction) => {
    child: PostgresTransaction;
    savepoint: string;
  };
  closeSavepoint: (
    parent: PostgresTransaction,
    child: PostgresTransaction,
  ) => void;
} = {
  open: classNotLoaded,
  finish: classNotLoaded,
  openSavepoint: classNotLoaded,
  closeSavepoint: classNotLoaded,
};

/**
 * An open transaction on one pooled client. Only `postgresTransaction`
 * creates it; a store bound to it writes inside that transaction. Its work is
 * sequential: while a savepoint opened on it runs, it refuses queries and new
 * savepoints, and once the transaction (or an enclosing one) ends it refuses
 * every query, because its client may already serve someone else.
 */
export class PostgresTransaction {
  static #savepoints = 0;

  static {
    bridge.open = (client) => new PostgresTransaction(client, undefined);
    bridge.finish = (tx) => {
      tx.#finished = true;
    };
    bridge.openSavepoint = (parent) => {
      parent.#assertUsable();
      const child = new PostgresTransaction(parent.#client, parent);
      parent.#child = child;
      return {
        child,
        savepoint: `deepagents_savepoint_${++PostgresTransaction.#savepoints}`,
      };
    };
    bridge.closeSavepoint = (parent, child) => {
      child.#finished = true;
      parent.#child = undefined;
    };
  }

  readonly #client: PoolClient;
  readonly #parent: PostgresTransaction | undefined;
  #child: PostgresTransaction | undefined;
  #finished = false;

  private constructor(
    client: PoolClient,
    parent: PostgresTransaction | undefined,
  ) {
    this.#client = client;
    this.#parent = parent;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>> {
    this.#assertUsable();
    return this.#client.query<Row>(text, values);
  }

  #assertUsable(): void {
    if (this.#isFinished()) {
      throw new Error(
        'PostgresTransaction: the transaction is already finished',
      );
    }
    if (this.#child) {
      throw new Error(
        'PostgresTransaction: a savepoint opened on this transaction is still running; run its work in sequence',
      );
    }
  }

  #isFinished(): boolean {
    const parent = this.#parent;
    return this.#finished || (parent !== undefined && parent.#isFinished());
  }
}

/**
 * Runs `fn` in one transaction and rethrows the error that ended it. On a
 * pool it opens the transaction on a pooled client; a ROLLBACK that fails too
 * means the connection is broken, so the pool discards the client instead of
 * handing it out again. On an open transaction it runs `fn` in a savepoint,
 * so a failure undoes only what `fn` wrote.
 */
export async function postgresTransaction<T>(
  db: Pool | PostgresTransaction,
  fn: (tx: PostgresTransaction) => Promise<T>,
): Promise<T> {
  if (db instanceof PostgresTransaction) {
    return inSavepoint(db, fn);
  }
  const client = await db.connect();
  client.on('error', surfacedThroughQueries);
  const tx = bridge.open(client);
  let broken = false;
  try {
    await client.query('BEGIN');
    let result: T;
    try {
      result = await fn(tx);
    } finally {
      bridge.finish(tx);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.off('error', surfacedThroughQueries);
    client.release(broken);
  }
}

async function inSavepoint<T>(
  parent: PostgresTransaction,
  fn: (tx: PostgresTransaction) => Promise<T>,
): Promise<T> {
  const { child, savepoint } = bridge.openSavepoint(parent);
  let result: T;
  try {
    await child.query(`SAVEPOINT ${savepoint}`);
    result = await fn(child);
  } catch (error) {
    bridge.closeSavepoint(parent, child);
    await parent.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    throw error;
  }
  bridge.closeSavepoint(parent, child);
  await parent.query(`RELEASE SAVEPOINT ${savepoint}`);
  return result;
}
