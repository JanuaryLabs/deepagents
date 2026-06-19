import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import pg from 'pg';

import { startPostgresContainer } from '@deepagents/test';

describe('startPostgresContainer readiness contract', () => {
  it('resolves to a container that accepts TCP queries immediately, no retry', async () => {
    await using container = await startPostgresContainer();
    if (!container) {
      return; // Docker not available.
    }

    // The contract every caller relies on: the moment startPostgresContainer
    // resolves, the connection string is usable over TCP — no retry loop. A
    // readiness probe that trusted the init-time socket-only server would let
    // this resolve before the real TCP server is listening, and this no-retry
    // connect would fail.
    const client = new pg.Client({
      connectionString: container.connectionString,
      connectionTimeoutMillis: 2_000,
    });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT 1 AS ok');
      assert.strictEqual(rows[0].ok, 1);
    } finally {
      await client.end();
    }
  });
});
