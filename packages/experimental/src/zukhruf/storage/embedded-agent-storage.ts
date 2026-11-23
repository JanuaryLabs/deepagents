import { PGlite } from '@electric-sql/pglite';
import { FileLock } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  type ContextStore,
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';

import { SqliteMailboxStore } from '../mailbox/sqlite.store.ts';
import type { MailboxStore } from '../mailbox/store.ts';
import {
  PgBossTurnQueue,
  type PgBossTurnQueueOptions,
} from '../queue/pg-boss.turn-queue.ts';
import { PgBossWakeScheduler } from '../queue/pg-boss.wake-scheduler.ts';
import type { TurnQueue } from '../queue/turn-queue.ts';
import type { WakeScheduler } from '../queue/wake-scheduler.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';
import {
  type AdmissionScope,
  AgentStorage,
  type AgentTree,
} from './agent-storage.ts';
import { SqliteAdmissionGate } from './sqlite-admission-gate.ts';
import { OutboxRelay, OutboxTurnQueue, TurnOutbox } from './turn-outbox.ts';

export interface EmbeddedAgentStorageOptions {
  /**
   * Where the storage keeps its files: `zukhruf.sqlite` (conversations,
   * streams, mail and the turn outbox) and `zukhruf.queue` (the PGlite
   * database of pg-boss), and `zukhruf.lock`, which the open storage holds.
   * Created when missing. One storage at a time: a second open rejects with
   * `EmbeddedAgentStorageInUseError`.
   */
  directory: string;
  /** Default: `pollingIntervalSeconds: 0.5`. */
  queue?: Omit<PgBossTurnQueueOptions, 'schema'>;
}

/** `open` found the directory held by another open storage, in this process or another. */
export class EmbeddedAgentStorageInUseError extends Error {
  override readonly name = 'EmbeddedAgentStorageInUseError';
  readonly directory: string;

  constructor(directory: string) {
    super(
      `EmbeddedAgentStorage: ${JSON.stringify(directory)} is open in another EmbeddedAgentStorage; one storage at a time may open a directory`,
    );
    this.directory = directory;
  }
}

function emitWarning(error: unknown): void {
  process.emitWarning(
    Error.isError(error) ? error : new Error(String(error), { cause: error }),
  );
}

/**
 * Agent storage for one process: the context, stream and mailbox stores on
 * one SQLite connection, and the turn queue and sandbox idle wakes on
 * pg-boss over PGlite, all under one directory, which the storage owns and
 * closes.
 *
 * An admission is one SQLite `BEGIN IMMEDIATE` transaction that holds the
 * connection alone, so admissions run one at a time, for every tree. A turn
 * pushed inside it becomes an outbox row of the same transaction; after the
 * commit a relay pushes the row to pg-boss as a job whose id is the row's, and
 * deletes the row. `open` pushes the rows a stopped process left.
 */
export class EmbeddedAgentStorage
  extends AgentStorage
  implements AsyncDisposable
{
  readonly store: ContextStore;
  readonly streams: StreamManager;
  readonly queue: TurnQueue;
  readonly mailboxStore: MailboxStore;
  readonly sandboxIdleWakes: WakeScheduler<SandboxIdleWake>;
  /** Started and owned; a host may bind it to plugins that keep jobs beside the turns. */
  readonly boss: PgBoss;
  /** The PGlite database pg-boss runs on, for transactions of such plugins. */
  readonly queueDatabase: PGlite;
  readonly #gate: SqliteAdmissionGate;
  readonly #scope: AdmissionScope;
  readonly #relay: OutboxRelay;
  readonly #resources: AsyncDisposableStack;

  private constructor(parts: {
    store: ContextStore;
    streams: StreamManager;
    queue: TurnQueue;
    mailboxStore: MailboxStore;
    sandboxIdleWakes: WakeScheduler<SandboxIdleWake>;
    boss: PgBoss;
    queueDatabase: PGlite;
    gate: SqliteAdmissionGate;
    scope: AdmissionScope;
    relay: OutboxRelay;
    resources: AsyncDisposableStack;
  }) {
    super();
    this.store = parts.store;
    this.streams = parts.streams;
    this.queue = parts.queue;
    this.mailboxStore = parts.mailboxStore;
    this.sandboxIdleWakes = parts.sandboxIdleWakes;
    this.boss = parts.boss;
    this.queueDatabase = parts.queueDatabase;
    this.#gate = parts.gate;
    this.#scope = parts.scope;
    this.#relay = parts.relay;
    this.#resources = parts.resources;
  }

  /**
   * Opens the storage in `directory` and pushes the turns its outbox still
   * holds. Rejects with `EmbeddedAgentStorageInUseError` while another storage
   * has the directory open.
   */
  static async open(
    options: EmbeddedAgentStorageOptions,
  ): Promise<EmbeddedAgentStorage> {
    await mkdir(options.directory, { recursive: true });
    await using resources = new AsyncDisposableStack();
    // Two storages on one directory would run two relays and two writers. The
    // kernel holds the lock, so a holder that dies, even by SIGKILL, frees it.
    const lock = resources.use(
      FileLock.open(join(options.directory, 'zukhruf.lock')),
    );
    if (!lock.tryLock()) {
      throw new EmbeddedAgentStorageInUseError(options.directory);
    }
    const database = resources.adopt(
      open(join(options.directory, 'zukhruf.sqlite')),
      (database) => database.close(),
    );
    const queueDatabase = resources.adopt(
      new PGlite(join(options.directory, 'zukhruf.queue')),
      (queueDatabase) => queueDatabase.close(),
    );
    const boss = new PgBoss({
      db: fromPglite(queueDatabase),
      backend: 'pglite',
    });
    // pg-boss reports its background failures here; no caller is left to take them.
    boss.on('error', emitWarning);
    await boss.start();
    resources.defer(() => boss.stop({ graceful: false }));
    const turns = await PgBossTurnQueue.create(boss, {
      pollingIntervalSeconds: 0.5,
      ...options.queue,
      schema: 'pgboss',
    });
    const sandboxIdleWakes = new PgBossWakeScheduler<SandboxIdleWake>(boss, {
      queue: `${turns.queue}-sandbox-idle`,
      pollingIntervalSeconds: 0.5,
    });
    await sandboxIdleWakes.initialize();

    const gate = new SqliteAdmissionGate(database);
    const store = new SqliteContextStore(database);
    const streamStore = new SqliteStreamStore(database);
    const mailboxStore = new SqliteMailboxStore(database);
    const outbox = new TurnOutbox(database);
    const relay = new OutboxRelay(gate, outbox, turns);
    resources.defer(() => relay.between(async () => undefined));
    const queue = new OutboxTurnQueue({ gate, outbox, relay, queue: turns });
    const streams = gate.view(streamStore);
    await relay.drain();

    return new EmbeddedAgentStorage({
      store: gate.view(store),
      streams: new StreamManager({
        store: streams,
        changeSource: new PollingChangeSource({ reads: streams }),
      }),
      queue,
      mailboxStore: gate.view(mailboxStore),
      sandboxIdleWakes,
      boss,
      queueDatabase,
      gate,
      scope: {
        store,
        streams: streamStore,
        mailboxStore,
        queue: queue.scope(),
      },
      relay,
      resources: resources.move(),
    });
  }

  /**
   * Runs `work` in one SQLite transaction while no other admission, to any
   * tree, runs. Resolves once it has committed; the relay then pushes the
   * turns it outboxed.
   */
  async admit<T>(
    _tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T> {
    const result = await this.#gate.admit(() => work(this.#scope));
    // A push that fails keeps its outbox row for the next drain: the next
    // admission's, the next push's, or the next open's.
    this.#relay.drain().catch(emitWarning);
    return result;
  }

  /** Waits for the relay, stops pg-boss, and closes both databases. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#resources.disposeAsync();
  }
}
