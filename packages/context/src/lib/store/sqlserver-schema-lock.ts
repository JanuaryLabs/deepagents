import type { ConnectionPool } from 'mssql';

/**
 * Runs schema DDL while holding an application lock keyed by the schema, so
 * openers that race on the same schema run their DDL one at a time.
 * `IF OBJECT_ID(...) IS NULL` checks are not atomic across sessions: without
 * the lock, concurrent openers deadlock or fail to create the schema.
 *
 * The lock lives in a transaction on its own pooled connection, and `run`
 * sends its batches through the pool's other connections, because full-text
 * DDL cannot run inside a user transaction. The transaction ends however `run`
 * ends, so the lock never outlives the open. The pool needs two connections.
 */
export async function withSqlServerSchemaLock<T>(
  mssql: typeof import('mssql'),
  pool: ConnectionPool,
  schema: string,
  run: () => Promise<T>,
): Promise<T> {
  const holder = new mssql.Transaction(pool);
  await holder.begin();
  let result: T;
  try {
    const lock = new mssql.Request(holder);
    lock.input(
      'resource',
      mssql.NVarChar(255),
      `deepagents:schema-ddl:${schema}`,
    );
    const { recordset } = await lock.query<{ status: number }>(`
      DECLARE @status int;
      EXEC @status = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = -1;
      SELECT @status AS status;
    `);
    if (recordset[0].status < 0) {
      throw new Error(
        `Could not lock the DDL of schema "${schema}": sp_getapplock returned ${recordset[0].status}.`,
      );
    }
    result = await run();
  } catch (error) {
    // The original error explains the failed open; a failed rollback only
    // means the connection, and the lock with it, is already gone.
    await holder.rollback().catch(() => {});
    throw error;
  }
  await holder.rollback();
  return result;
}
