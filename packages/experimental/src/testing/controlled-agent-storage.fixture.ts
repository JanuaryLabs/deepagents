import { Mutex } from '@zukhruf/mutex';
import { MemoryStore } from '@zukhruf/mutex/memory';

import type { ContextStore, StreamManager } from '@deepagents/context';
import {
  type AdmissionScope,
  AgentStorage,
  type AgentTree,
  type MailboxStore,
  type TurnQueue,
} from '@deepagents/experimental/zukhruf';

export interface ControlledAgentStorageParts {
  store: ContextStore;
  streams: StreamManager;
  queue: TurnQueue;
  mailboxStore: MailboxStore;
}

/**
 * Storage over the in-process parts a test builds. Admissions to one tree
 * take turns inside this process and write straight to the parts: nothing
 * rolls back, and no other process shares the lock.
 */
export class ControlledAgentStorage extends AgentStorage {
  readonly store: ContextStore;
  readonly streams: StreamManager;
  readonly queue: TurnQueue;
  readonly mailboxStore: MailboxStore;
  readonly #trees = new Mutex(new MemoryStore());

  constructor(parts: ControlledAgentStorageParts) {
    super();
    this.store = parts.store;
    this.streams = parts.streams;
    this.queue = parts.queue;
    this.mailboxStore = parts.mailboxStore;
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
      }),
    );
  }
}
