import type { ContextFragment } from '../fragments.ts';
import type { ContextStore, MessageData } from '../store/store.ts';

export interface SavePipelineEngine {
  readonly store: ContextStore;
  readonly chatId: string;
  getActiveBranch(): { id: string; headMessageId: string | null };
  commitHead(
    headMessageId: string,
    expectedHeadMessageId: string | null,
  ): Promise<boolean>;
  refreshBranch(): Promise<{ id: string; headMessageId: string | null }>;
  rewindForUpdate(parentId: string): Promise<void>;
}

/**
 * Thrown when persist() exhausts its commit attempts because concurrent
 * writers kept moving the branch head. The pending messages are stored but
 * not committed as the head; the caller decides whether to retry the save.
 */
export class HeadConflictError extends Error {
  constructor(chatId: string, headMessageId: string) {
    super(
      `Could not commit head "${headMessageId}" for chat "${chatId}": ` +
        'concurrent writers kept moving the branch head',
    );
    this.name = 'HeadConflictError';
  }
}

export interface SaveResult {
  headMessageId: string | undefined;
}

export class SavePipeline {
  #engine: SavePipelineEngine;
  #pending: ContextFragment[];
  #shouldBranch = true;

  constructor(engine: SavePipelineEngine, pending: ContextFragment[]) {
    this.#engine = engine;
    this.#pending = pending;
  }

  async applyUpdateBranching(shouldBranch: boolean): Promise<this> {
    this.#shouldBranch = shouldBranch;
    if (!shouldBranch) return this;

    for (const fragment of this.#pending) {
      if (!fragment.id) continue;
      const existing = await this.#engine.store.getMessage(fragment.id);
      if (existing && existing.parentId) {
        await this.#engine.rewindForUpdate(existing.parentId);
        fragment.id = crypto.randomUUID();
        return this;
      }
    }
    return this;
  }

  async persist(): Promise<SaveResult> {
    let parentId: string | null = this.#engine.getActiveBranch().headMessageId;
    const now = Date.now();
    const messages: MessageData[] = [];
    const pendingMessagesById = new Map<string, MessageData>();

    for (const fragment of this.#pending) {
      if (!fragment.codec) {
        throw new Error(`Fragment "${fragment.name}" is missing codec.`);
      }

      const msgId = fragment.id ?? crypto.randomUUID();

      let msgParentId: string | null = parentId;
      if (!this.#shouldBranch && msgId === parentId) {
        const existing =
          pendingMessagesById.get(msgId) ??
          (await this.#engine.store.getMessage(msgId));
        if (existing) msgParentId = existing.parentId;
      }

      const messageData: MessageData = {
        id: msgId,
        chatId: this.#engine.chatId,
        parentId: msgParentId,
        name: fragment.name,
        type: fragment.type,
        data: fragment.codec.encode(),
        createdAt: now,
      };

      messages.push(messageData);
      pendingMessagesById.set(messageData.id, messageData);
      parentId = messageData.id;
    }

    if (parentId === null) {
      throw new Error(
        'Pipeline persisted no messages but pending was not empty',
      );
    }
    await this.#engine.store.addMessages(messages);
    await this.#commitHead(messages[0], parentId);
    return { headMessageId: parentId };
  }

  static readonly #maxCommitAttempts = 5;

  /**
   * Advance the branch head to `newHead` through the store's CAS. A stale
   * cached head must never rewind the branch (that silently orphans turns
   * committed in between), so a rejected CAS re-reads the store head and
   * reconciles:
   * - the store head already descends from `newHead` (an in-place assistant
   *   fill whose turn was built past): content is on the chain, keep the
   *   store head;
   * - `newHead` descends from the store head: fast-forward, retry against it;
   * - true fork (another turn won the same head): graft this turn onto the
   *   winning head by re-parenting the first pending message, then retry.
   *   Grafting applies only to messages chained off the stale head — an
   *   in-place fill keeps its original parent and its content already landed.
   */
  async #commitHead(first: MessageData, newHead: string): Promise<void> {
    let expected = this.#engine.getActiveBranch().headMessageId;
    for (let i = 0; i < SavePipeline.#maxCommitAttempts; i++) {
      if (await this.#engine.commitHead(newHead, expected)) return;

      const fresh = (await this.#engine.refreshBranch()).headMessageId;
      if (fresh === null || fresh === expected) {
        expected = fresh;
        continue;
      }
      if (await this.#chainContains(fresh, newHead)) return;
      if (await this.#chainContains(newHead, fresh)) {
        expected = fresh;
        continue;
      }
      if (first.parentId !== expected) return;
      await this.#engine.store.setMessageParent(first.id, fresh);
      first.parentId = fresh;
      expected = fresh;
    }
    throw new HeadConflictError(this.#engine.chatId, newHead);
  }

  async #chainContains(headId: string, messageId: string): Promise<boolean> {
    const chain = await this.#engine.store.getMessageChain(headId);
    return chain.some((message) => message.id === messageId);
  }
}
