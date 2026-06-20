import type { ChainSummary } from '../chain-summary.ts';
import type { ContextFragment } from '../fragments.ts';
import {
  type BaseWhenCtx,
  type UserReminder,
  type WhenContext,
  isConditionalReminder,
  user,
} from '../fragments/message/user.ts';
import type { ContextStore, MessageData } from '../store/store.ts';
import { extractPlainText } from '../text.ts';
import { requireUserUIMessage } from '../ui-message-guards.ts';
import { evaluateFiredReminders } from './reminder-eval.ts';

export interface SavePipelineEngine {
  readonly store: ContextStore;
  readonly chatId: string;
  readonly branchName: string;
  getActiveBranch(): { id: string; headMessageId: string | null };
  commitHead(headMessageId: string): Promise<void>;
  rewindForUpdate(parentId: string): Promise<void>;
  getChainSummary(): Promise<ChainSummary>;
  buildBaseWhenCtx(chain: ChainSummary): BaseWhenCtx;
}

export interface SaveResult {
  headMessageId: string | undefined;
}

export class SavePipeline {
  #engine: SavePipelineEngine;
  #pending: ContextFragment[];
  #fragments: ContextFragment[];
  #shouldBranch = true;

  constructor(
    engine: SavePipelineEngine,
    pending: ContextFragment[],
    fragments: ContextFragment[],
  ) {
    this.#engine = engine;
    this.#pending = pending;
    this.#fragments = fragments;
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

  /**
   * Fold any fired `target: 'user'` conditional reminders into the last pending
   * user message. `steer` reminders fire mid-loop via the engine's prepareStep
   * hook and `tool-output` reminders wrap at tool-execution time, so neither is
   * handled here — the save pipeline only carries user-message reminders.
   */
  async evaluateUserReminders(): Promise<this> {
    const configs = this.#fragments
      .filter(isConditionalReminder)
      .map((fragment) => fragment.metadata.reminder)
      .filter((config) => config.target === 'user');
    if (configs.length === 0) return this;

    const fragmentIndex = this.#pending.findLastIndex(
      (fragment) => fragment.name === 'user',
    );
    if (fragmentIndex < 0) return this;
    const fragment = this.#pending[fragmentIndex];
    if (!fragment.codec) return this;
    const message = requireUserUIMessage(
      fragment.codec.encode(),
      `Pending user fragment "${fragment.name}"`,
    );

    const chain = await this.#engine.getChainSummary();
    const whenCtx: WhenContext = {
      ...this.#engine.buildBaseWhenCtx(chain),
      content: extractPlainText(message),
      currentMessage: message,
      lastAssistantMessage: chain.lastAssistantMessage,
      lastAssistantMessages: chain.lastAssistantMessages,
    };

    const matched = await evaluateFiredReminders(configs, whenCtx);
    if (matched.length === 0) return this;

    const reminders: UserReminder[] = matched.map((m) => ({
      text: m.resolved.text,
      asPart: m.config.asPart,
      target: 'user',
      metadata: m.resolved.metadata,
    }));
    const originalId = fragment.id;
    const recreated = user(
      originalId ? { ...message, id: originalId } : message,
      ...reminders,
    );
    if (originalId) recreated.id = originalId;
    this.#pending[fragmentIndex] = recreated;

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
