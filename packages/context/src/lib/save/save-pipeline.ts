import type { ContextFragment } from '../fragments.ts';
import type { ContextStore, MessageData } from '../store/store.ts';

export interface SavePipelineEngine {
  readonly store: ContextStore;
  readonly chatId: string;
  getActiveBranch(): { id: string; headMessageId: string | null };
  commitHead(headMessageId: string): Promise<void>;
  rewindForUpdate(parentId: string): Promise<void>;
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
    await this.#engine.commitHead(parentId);
    return { headMessageId: parentId };
  }
}
