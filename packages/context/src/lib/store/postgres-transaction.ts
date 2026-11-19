import type { Pool, PoolClient } from 'pg';

/**
 * A connection that dies mid-transaction emits the same error it rejects the
 * pending queries with. pg-pool listens only on idle clients, so without this
 * listener the event would crash the process; the queries still surface it.
 */
function surfacedThroughQueries(): void {}

/**
 * Runs `fn` in one transaction on a pooled client and rethrows the error that
 * ended it. A ROLLBACK that fails too means the connection is broken, so the
 * pool discards the client instead of handing it out again.
 */
export async function postgresTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  client.on('error', surfacedThroughQueries);
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
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
