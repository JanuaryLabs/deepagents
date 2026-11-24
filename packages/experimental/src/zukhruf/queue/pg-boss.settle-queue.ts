import type { PgBoss } from 'pg-boss';
import { v7 as uuidv7 } from 'uuid';

import { PgBossWakeScheduler } from './pg-boss.wake-scheduler.ts';
import type { SettleIntent, SettleQueue } from './settle-intent.ts';

/** The queue of one follow-up's settle intents, beside the turn queue it follows. */
export function settleQueueName(turnQueue: string, followUp: string): string {
  return `${turnQueue}-settle-${followUp}`;
}

/**
 * Opens the settle queue `queue`, creating it when missing, with the wake
 * queues' retries: 20, with backoff up to 60 s; a job that uses them all
 * stays `failed`.
 */
export async function openSettleQueue(
  boss: PgBoss,
  queue: string,
): Promise<SettleQueue> {
  const wakes = new PgBossWakeScheduler<SettleIntent>(boss, {
    queue,
    pollingIntervalSeconds: 0.5,
  });
  await wakes.initialize();
  // pg-boss looks up queue metadata on its own database before it honors a
  // transaction's `db`; a cache miss inside an admission would wait for a
  // pool connection the transaction may be holding. Fill the cache now.
  await boss.findJobs(queue, { id: uuidv7() });
  return { consume: (handler) => wakes.consume(({ data }) => handler(data)) };
}
