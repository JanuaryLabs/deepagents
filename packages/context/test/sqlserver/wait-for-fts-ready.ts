import sql from 'mssql';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Waits until the context store's full-text catalogs stop populating, so a
 * CONTAINSTABLE query sees every row. A server without catalogs (Azure SQL
 * Edge) returns at once: the store then searches with LIKE.
 */
export async function waitForFtsReady(
  connectionString: string,
  maxWaitMs = 10_000,
  pollIntervalMs = 100,
): Promise<void> {
  const pool = await sql.connect(connectionString);
  try {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const result = await pool.request().query(`
        SELECT FULLTEXTCATALOGPROPERTY(name, 'PopulateStatus') AS status
        FROM sys.fulltext_catalogs
        WHERE name LIKE '%context_store_catalog'
      `);
      if (result.recordset.every((c) => c.status === 0 || c.status == null))
        return;
      await sleep(pollIntervalMs);
    }
  } finally {
    await pool.close();
  }
}
