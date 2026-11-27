import type { Pool } from 'pg';
import type { Db, PgBoss } from 'pg-boss';
import { z } from 'zod';

import {
  PostgresContextStore,
  PostgresNotifyChangeSource,
  PostgresStreamStore,
  type StreamChangeSource,
  StreamManager,
  postgresTransaction,
} from '@deepagents/context';

import { PostgresAdmittedMessageStore } from '../admitted-messages/postgres.store.ts';
import { PostgresDeletedConversationStore } from '../deleted-conversations/postgres.store.ts';
import { PostgresMailboxStore } from '../mailbox/postgres.store.ts';
import {
  openSettleQueue,
  settleQueueName,
} from '../queue/pg-boss.settle-queue.ts';
import {
  PgBossTurnQueue,
  type PgBossTurnQueueOptions,
} from '../queue/pg-boss.turn-queue.ts';
import { PgBossWakeScheduler } from '../queue/pg-boss.wake-scheduler.ts';
import type { SettleQueue } from '../queue/settle-intent.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';
import {
  type AdmissionScope,
  AgentStorage,
  type AgentTree,
} from './agent-storage.ts';

/** One PostgreSQL database: its name on one server, told apart by the cluster's system identifier. */
export interface PostgresDatabaseIdentity {
  database: string;
  systemIdentifier: string;
}

const DATABASE_IDENTITY_SQL = `SELECT current_database() AS database,
  (pg_control_system()).system_identifier::text AS "systemIdentifier"`;

const databaseIdentityRowsSchema = z.tuple([
  z.object({ database: z.string(), systemIdentifier: z.string() }),
]);

async function databaseIdentity(
  result: Promise<{ rows: unknown[] }>,
): Promise<PostgresDatabaseIdentity> {
  return databaseIdentityRowsSchema.parse((await result).rows)[0];
}

/** The pool and PgBoss reach different databases, so one transaction cannot hold both. */
export class AgentStorageDatabaseMismatchError extends Error {
  override readonly name = 'AgentStorageDatabaseMismatchError';
  readonly pool: PostgresDatabaseIdentity;
  readonly boss: PostgresDatabaseIdentity;

  constructor(pool: PostgresDatabaseIdentity, boss: PostgresDatabaseIdentity) {
    super(
      `PostgresAgentStorage needs the pool and PgBoss on one database; the pool reaches "${pool.database}" (system ${pool.systemIdentifier}) and PgBoss reaches "${boss.database}" (system ${boss.systemIdentifier})`,
    );
    this.pool = pool;
    this.boss = boss;
  }
}

export interface PostgresAgentStorageOptions {
  /** Borrowed: the host owns the pool and ends it after the storage is disposed. */
  pool: Pool;
  /** Borrowed and started: the host stops it. It must use the pool's database. */
  boss: PgBoss;
  /** PostgreSQL schema of the context, stream, mailbox and deleted-chat tables. Default: `public`. */
  schema?: string;
  queue?: PgBossTurnQueueOptions;
  /**
   * Wakes stream readers. Borrowed when given. Default: a
   * `PostgresNotifyChangeSource` on the pool, which the storage closes.
   */
  changeSource?: StreamChangeSource;
}

/**
 * Agent storage on one PostgreSQL database: the context, stream and mailbox
 * stores on the host's pool and the turn queue and sandbox idle wakes on
 * PgBoss, which must reach the same database. An admission is one transaction
 * under a per-tree advisory lock, so a session that dies mid-admission leaves
 * nothing.
 *
 * Dispose it before ending the pool: it closes the change source it opened.
 */
export class PostgresAgentStorage
  extends AgentStorage
  implements AsyncDisposable
{
  readonly store: PostgresContextStore;
  readonly streams: StreamManager;
  readonly queue: PgBossTurnQueue;
  readonly mailboxStore: PostgresMailboxStore;
  readonly sandboxIdleWakes: PgBossWakeScheduler<SandboxIdleWake>;
  readonly deletedConversations: PostgresDeletedConversationStore;
  readonly #pool: Pool;
  readonly #boss: PgBoss;
  readonly #schema: string;
  readonly #streamStore: PostgresStreamStore;
  readonly #admittedMessages: PostgresAdmittedMessageStore;
  readonly #ownedChangeSource: PostgresNotifyChangeSource | undefined;

  private constructor(parts: {
    pool: Pool;
    boss: PgBoss;
    schema: string;
    store: PostgresContextStore;
    streamStore: PostgresStreamStore;
    streams: StreamManager;
    queue: PgBossTurnQueue;
    mailboxStore: PostgresMailboxStore;
    sandboxIdleWakes: PgBossWakeScheduler<SandboxIdleWake>;
    deletedConversations: PostgresDeletedConversationStore;
    admittedMessages: PostgresAdmittedMessageStore;
    ownedChangeSource: PostgresNotifyChangeSource | undefined;
  }) {
    super();
    this.#pool = parts.pool;
    this.#boss = parts.boss;
    this.#schema = parts.schema;
    this.store = parts.store;
    this.#streamStore = parts.streamStore;
    this.streams = parts.streams;
    this.queue = parts.queue;
    this.mailboxStore = parts.mailboxStore;
    this.sandboxIdleWakes = parts.sandboxIdleWakes;
    this.deletedConversations = parts.deletedConversations;
    this.#admittedMessages = parts.admittedMessages;
    this.#ownedChangeSource = parts.ownedChangeSource;
  }

  /**
   * Opens the storage: checks that the pool and PgBoss reach one database,
   * then creates the tables, the turn queue and the sandbox idle wake queue.
   */
  static async create(
    options: PostgresAgentStorageOptions,
  ): Promise<PostgresAgentStorage> {
    const { pool, boss } = options;
    const schema = options.schema ?? 'public';
    const [poolIdentity, bossIdentity] = await Promise.all([
      databaseIdentity(pool.query(DATABASE_IDENTITY_SQL)),
      databaseIdentity(boss.getDb().executeSql(DATABASE_IDENTITY_SQL)),
    ]);
    if (
      poolIdentity.database !== bossIdentity.database ||
      poolIdentity.systemIdentifier !== bossIdentity.systemIdentifier
    ) {
      throw new AgentStorageDatabaseMismatchError(poolIdentity, bossIdentity);
    }
    const store = await PostgresContextStore.create({ pool, schema });
    const streamStore = await PostgresStreamStore.create({ pool, schema });
    const mailboxStore = await PostgresMailboxStore.create({ pool, schema });
    const deletedConversations = await PostgresDeletedConversationStore.create({
      pool,
      schema,
    });
    const admittedMessages = await PostgresAdmittedMessageStore.create({
      pool,
      schema,
    });
    const queue = await PgBossTurnQueue.create(boss, options.queue);
    const sandboxIdleWakes = new PgBossWakeScheduler<SandboxIdleWake>(boss, {
      queue: `${queue.queue}-sandbox-idle`,
      pollingIntervalSeconds: 0.5,
    });
    await sandboxIdleWakes.initialize();
    let changeSource = options.changeSource;
    let ownedChangeSource: PostgresNotifyChangeSource | undefined;
    if (changeSource === undefined) {
      ownedChangeSource = await PostgresNotifyChangeSource.create({
        pool,
        schema,
      });
      changeSource = ownedChangeSource;
    }
    return new PostgresAgentStorage({
      pool,
      boss,
      schema,
      store,
      streamStore,
      streams: new StreamManager({ store: streamStore, changeSource }),
      queue,
      mailboxStore,
      sandboxIdleWakes,
      deletedConversations,
      admittedMessages,
      ownedChangeSource,
    });
  }

  settleQueue(followUp: string): Promise<SettleQueue> {
    return openSettleQueue(
      this.#boss,
      settleQueueName(this.queue.queue, followUp),
    );
  }

  /** Runs `work` in one transaction under the tree's advisory lock; its settle intents and idle wakes are pg-boss jobs of that transaction. */
  admit<T>(
    tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T> {
    return postgresTransaction(this.#pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `zukhruf:agent-tree:${JSON.stringify([this.#schema, tree.userId, tree.treeId])}`,
      ]);
      const db: Db = { executeSql: (text, values) => tx.query(text, values) };
      return work({
        store: this.store.bind(tx),
        streams: this.#streamStore.bind(tx),
        mailboxStore: this.mailboxStore.bind(tx),
        queue: this.queue.bind(tx),
        settleIntents: {
          record: async (followUp, id, intent) => {
            await this.#boss.send(
              settleQueueName(this.queue.queue, followUp),
              intent,
              { id, db },
            );
          },
        },
        sandboxIdleWakes: this.sandboxIdleWakes.bind(db),
        deletedConversations: this.deletedConversations.bind(tx),
        admittedMessages: this.#admittedMessages.bind(tx),
      });
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#ownedChangeSource?.close();
  }
}
