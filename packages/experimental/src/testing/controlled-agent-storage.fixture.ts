import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

import type {
  ContextStore,
  StreamManager,
  StreamStore,
} from '@deepagents/context';
import {
  type AdmissionScope,
  AdmittedMessageStore,
  AgentStorage,
  type AgentTree,
  DeletedConversationStore,
  type MailboxStore,
  type SandboxIdleWake,
  type SettleQueue,
  type TurnQueue,
  WakeScheduler,
} from '@deepagents/experimental/zukhruf';

import { ControlledSettleQueues } from './controlled-settle-queues.fixture.ts';

export interface ControlledAgentStorageParts {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  mailboxStore: MailboxStore;
  /** Where admissions record settle intents. Default: queues no test drains. */
  settleQueues?: ControlledSettleQueues;
}

function unusedWakes(): Error {
  return new Error('this storage never schedules a sandbox idle wake');
}

class UnusedSandboxIdleWakes extends WakeScheduler<SandboxIdleWake> {
  override async schedule(): Promise<void> {
    throw unusedWakes();
  }

  override async cancel(): Promise<void> {
    throw unusedWakes();
  }

  override async consume(): Promise<AsyncDisposable> {
    throw unusedWakes();
  }
}

class MemoryDeletedConversations extends DeletedConversationStore {
  readonly #deleted = new Set<string>();

  override async has(chatId: string): Promise<boolean> {
    return this.#deleted.has(chatId);
  }

  override async add(chatId: string): Promise<void> {
    this.#deleted.add(chatId);
  }
}

class MemoryAdmittedMessages extends AdmittedMessageStore {
  readonly #digests = new Map<string, { chatId: string; digest: string }>();

  override async digestOf(turnId: string): Promise<string | undefined> {
    return this.#digests.get(turnId)?.digest;
  }

  override async record(
    turnId: string,
    chatId: string,
    digest: string,
  ): Promise<void> {
    this.#digests.set(turnId, { chatId, digest });
  }

  override async forget(chatId: string): Promise<void> {
    for (const [turnId, admitted] of this.#digests) {
      if (admitted.chatId === chatId) this.#digests.delete(turnId);
    }
  }
}

/** The digests live beside the stream rows they are written with, so storages over one stream store share them, as storages on one database do. */
const admittedMessagesByStreams = new WeakMap<
  StreamStore,
  MemoryAdmittedMessages
>();

function admittedMessagesBeside(streams: StreamStore): MemoryAdmittedMessages {
  let admitted = admittedMessagesByStreams.get(streams);
  if (!admitted) {
    admitted = new MemoryAdmittedMessages();
    admittedMessagesByStreams.set(streams, admitted);
  }
  return admitted;
}

/**
 * Storage over the in-process parts a test builds. Admissions to one tree
 * take turns inside this process and write straight to the parts: nothing
 * rolls back, and no other process shares the lock. It has no sandbox idle
 * wakes; its settle intents wait in `settleQueues` until a test drains them.
 */
export class ControlledAgentStorage extends AgentStorage {
  readonly store: ContextStore;
  readonly streams: StreamManager;
  readonly queue: TurnQueue;
  readonly mailboxStore: MailboxStore;
  readonly sandboxIdleWakes = new UnusedSandboxIdleWakes();
  readonly deletedConversations = new MemoryDeletedConversations();
  readonly #admittedMessages: MemoryAdmittedMessages;
  readonly settleQueues: ControlledSettleQueues;
  readonly #trees = new Mutex(new MemoryStore());

  constructor(parts: ControlledAgentStorageParts) {
    super();
    this.store = parts.store;
    this.streams = parts.streams;
    this.queue = parts.queue;
    this.mailboxStore = parts.mailboxStore;
    this.settleQueues = parts.settleQueues ?? new ControlledSettleQueues();
    this.#admittedMessages = admittedMessagesBeside(parts.streams.store);
  }

  async settleQueue(followUp: string): Promise<SettleQueue> {
    return this.settleQueues.queue(followUp);
  }

  admit<T>(
    tree: AgentTree,
    work: (scope: AdmissionScope) => Promise<T>,
  ): Promise<T> {
    return this.#trees.acquire(JSON.stringify([tree.userId, tree.treeId]), () =>
      work({
        store: this.store,
        streams: this.streams.store,
        mailboxStore: this.mailboxStore,
        queue: this.queue,
        settleIntents: this.settleQueues,
        sandboxIdleWakes: this.sandboxIdleWakes,
        deletedConversations: this.deletedConversations,
        admittedMessages: this.#admittedMessages,
      }),
    );
  }
}
