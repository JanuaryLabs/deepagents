import {
  ContextEngine,
  type ContextStore,
  type StreamStore,
} from '@deepagents/context';

import type { TransactionalMailboxStore } from '../mailbox/store.ts';
import type { ConversationId } from '../mailbox/types.ts';
import type { TransactionalTurnQueue, TurnRef } from '../queue/turn-queue.ts';
import { isPausedHead } from '../runtime/approval-controller.ts';
import type {
  AdmissionScope,
  AgentStorage,
  AgentTree,
} from '../storage/agent-storage.ts';
import { AgentDirectory } from './agent-directory.ts';
import { AgentThread } from './agent-thread.ts';
import { ConversationNotFoundError } from './conversation-not-found-error.ts';

/**
 * One admission to an agent tree: the storage parts bound to its unit, and
 * the Codex V2 residency rule read through them.
 */
export class Admission {
  readonly store: ContextStore;
  readonly streams: StreamStore;
  readonly mailboxStore: TransactionalMailboxStore;
  readonly queue: TransactionalTurnQueue;
  readonly directory: AgentDirectory;
  readonly #scope: AdmissionScope;
  readonly #tree: AgentTree;
  readonly #member: AgentThread | undefined;
  readonly #residentLimit: number;

  constructor(options: {
    scope: AdmissionScope;
    tree: AgentTree;
    member: AgentThread | undefined;
    residentLimit: number;
    pushed: (turn: TurnRef) => void;
  }) {
    const { scope } = options;
    this.#scope = scope;
    this.#tree = options.tree;
    this.#member = options.member;
    this.#residentLimit = options.residentLimit;
    this.store = scope.store;
    this.streams = scope.streams;
    this.mailboxStore = scope.mailboxStore;
    this.queue = {
      push: async (turn) => {
        await scope.queue.push(turn);
        options.pushed(turn);
      },
      getTurnActivity: (conversation) =>
        scope.queue.getTurnActivity(conversation),
    };
    this.directory = new AgentDirectory(scope.store);
  }

  /**
   * Whether `target` may start a turn: the root always may, and so may a
   * target that is already resident. Any other sub-agent needs one of the
   * tree's `maxConcurrentThreadsPerSession - 1` resident slots, which the
   * tree's other non-evictable sub-agents hold.
   */
  async admits(target: ConversationId): Promise<boolean> {
    if (target.chatId === this.#tree.treeId) return true;
    if (!this.#member) {
      throw new Error(
        `Admission.admits: chat "${target.chatId}" is not in tree "${this.#tree.treeId}"`,
      );
    }
    const members = await this.directory.listTree(this.#member);
    const existing = members.find(
      (member) => member.conversation.chatId === target.chatId,
    );
    if (existing && (await this.#isResident(existing))) return true;
    let resident = 0;
    for (const member of members) {
      if (resident >= this.#residentLimit) break;
      if (member.path.isRoot || member === existing) continue;
      if (await this.#isResident(member)) resident++;
    }
    return resident < this.#residentLimit;
  }

  /** Registers `streamId` as a queued stream, as `StreamManager.register` does. */
  async registerStream(streamId: string): Promise<void> {
    await this.streams.upsertStream({
      id: streamId,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      error: null,
    });
  }

  /**
   * Codex `is_unloadable` negated: a sub-agent with a queued or running turn,
   * with trigger-turn mail waiting, or paused on a host decision.
   */
  async #isResident(member: AgentThread): Promise<boolean> {
    const { conversation } = member;
    if ((await this.#scope.queue.getTurnActivity(conversation)) !== 'idle') {
      return true;
    }
    if (await this.#scope.mailboxStore.hasPendingTriggerTurn(conversation)) {
      return true;
    }
    const head = (
      await new ContextEngine({
        store: this.#scope.store,
        chatId: conversation.chatId,
        userId: conversation.userId,
      }).getMessages()
    ).at(-1);
    return isPausedHead(head);
  }
}

export interface AgentResidencyOptions {
  storage: AgentStorage;
  directory: AgentDirectory;
  /** Codex `max_concurrent_threads_per_session`, root included. */
  maxConcurrentThreadsPerSession: number;
  /** Signals that a conversation's status may have changed. Never rejects. */
  publish: (conversation: ConversationId) => Promise<void>;
}

/**
 * Codex V2 residency for an agent tree: every turn pushed to a tree member
 * is admitted in one `AgentStorage.admit` unit, which counts the resident
 * sub-agents and writes the turn together, so concurrent admissions on any
 * worker cannot overshoot the limit and a dead one leaves nothing.
 */
export class AgentResidency {
  readonly #storage: AgentStorage;
  readonly #directory: AgentDirectory;
  readonly #residentLimit: number;
  readonly #publish: AgentResidencyOptions['publish'];

  constructor(options: AgentResidencyOptions) {
    this.#storage = options.storage;
    this.#directory = options.directory;
    this.#residentLimit = options.maxConcurrentThreadsPerSession - 1;
    this.#publish = options.publish;
  }

  /**
   * Runs `work` as one admission to the tree of `member`, a tree member or a
   * conversation that is not one yet (a root to be). After the unit commits,
   * publishes the status of every conversation it pushed a turn to.
   */
  async admit<T>(
    member: AgentThread | ConversationId,
    work: (admission: Admission) => Promise<T>,
  ): Promise<T> {
    const thread =
      member instanceof AgentThread
        ? member
        : await this.#directory.load(member);
    const conversation =
      member instanceof AgentThread ? member.conversation : member;
    // A conversation with no thread yet becomes a root: its tree is its own.
    const tree: AgentTree = {
      userId: conversation.userId,
      treeId: thread?.treeId ?? conversation.chatId,
    };
    const pushed = new Map<string, ConversationId>();
    const result = await this.#storage.admit(tree, async (scope) => {
      // A tree whose delete has begun reads as absent, so nothing enters it
      // while its delete runs, on any worker; a deleted chat's id stays
      // refused, so nothing opens it again as a new root.
      if (
        (await AgentResidency.#deleting(scope, tree)) ||
        (await scope.deletedConversations.has(conversation.chatId))
      ) {
        throw new ConversationNotFoundError(conversation.chatId);
      }
      return work(
        new Admission({
          scope,
          tree,
          member: thread,
          residentLimit: this.#residentLimit,
          pushed: ({ chatId, userId }) =>
            pushed.set(JSON.stringify([chatId, userId]), { chatId, userId }),
        }),
      );
    });
    for (const target of pushed.values()) await this.#publish(target);
    return result;
  }

  static async #deleting(
    scope: AdmissionScope,
    tree: AgentTree,
  ): Promise<boolean> {
    const root = await scope.store.getChat(tree.treeId);
    if (root?.userId !== tree.userId) return false;
    return (
      AgentThread.fromMetadata(
        { chatId: root.id, userId: root.userId },
        root.metadata,
      )?.deletingAt !== undefined
    );
  }
}
