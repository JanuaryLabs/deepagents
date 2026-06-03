import { createHash } from 'node:crypto';
import type pg from 'pg';

import type { IndexLock } from '@deepagents/text2sql';

/**
 * {@link IndexLock} backed by Postgres session-level advisory locks.
 *
 * Safe across separate daemon processes/containers pointed at the same
 * database: `pg_advisory_lock` blocks until the key is free, so only one holder
 * proceeds at a time and the rest wait. Acquire + release run on the same
 * pooled connection (advisory locks are session-scoped). Pair with a shared
 * {@link import('@deepagents/text2sql').FileIndexCache} directory to turn that
 * serialization into fleet-wide single-flight introspection.
 */
export class PgAdvisoryIndexLock implements IndexLock {
  readonly #pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.#pool = pool;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockId = advisoryKey(key);
    const client = await this.#pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [lockId]);
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
      }
    } finally {
      client.release();
    }
  }
}

function advisoryKey(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hash}`)).toString();
}
