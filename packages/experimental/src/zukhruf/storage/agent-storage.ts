import type {
  ContextStore,
  StreamManager,
  StreamStore,
} from '@deepagents/context';

import type {
  MailboxStore,
  TransactionalMailboxStore,
} from '../mailbox/store.ts';
import type {
  SettleQueue,
  TransactionalSettleIntents,
} from '../queue/settle-intent.ts';
import type { TransactionalTurnQueue, TurnQueue } from '../queue/turn-queue.ts';
import type { WakeScheduler } from '../queue/wake-scheduler.ts';
import type { SandboxIdleWake } from '../sandbox/sandbox-idle-wake.ts';

/** An agent tree: the root conversation and every sub-agent under it. */
export interface AgentTree {
  userId: string;
  /** The root conversation's chat id. */
  treeId: string;
}

/**
 * The storage parts as one admission sees them: every read and write lands
 * in one unit, which commits when `work` resolves and leaves nothing when it
 * throws or its process dies.
 */
export interface AdmissionScope {
  store: ContextStore;
  streams: StreamStore;
  mailboxStore: TransactionalMailboxStore;
  queue: TransactionalTurnQueue;
  /** The settle intents of the follow-ups `settleQueue` opened. */
  settleIntents: TransactionalSettleIntents;
}

/**
 * Where a runtime keeps its conversations, streams, turns and mail, and how
 * it admits work to an agent tree. A storage builds its parts on one
 * database, so `admit` can bind all of them to one transaction; there is no
 * way to hand it parts that live elsewhere.
 */
export abstract class AgentStorage {
  abstract readonly store: ContextStore;
  /** Stream subsystem over this storage's stream store. */
  abstract readonly streams: StreamManager;
  abstract readonly queue: TurnQueue;
  /** Durable pending inter-agent input. Distinct from the TurnQueue scheduler. */
  abstract readonly mailboxStore: MailboxStore;
  /** Due stops of idle chats' sandboxes, on their own queue beside the turn queue. */
  abstract readonly sandboxIdleWakes: WakeScheduler<SandboxIdleWake>;

  /**
   * Opens the queue of `followUp`'s settle intents, creating it when
   * missing. An admission records intents only for a follow-up whose queue
   * is open.
   */
  abstract settleQueue(followUp: string): Promise<SettleQueue>;

  /**
   * Runs `work` while no other admission to `tree` runs, on any worker that
   * shares this storage's database, with the parts bound to one unit.
   * Resolves with what `work` returned once that unit has committed.
   */
  abstract admit<T>(
    tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T>;
}
