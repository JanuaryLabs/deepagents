import type { UIMessage } from 'ai';

import type { ChainSummary } from '../chain-summary.ts';
import type { ContextFragment } from '../fragments.ts';
import {
  type ConditionalReminder,
  type ReminderResolution,
  type ReminderTarget,
  isConditionalReminder,
  resolveReminderAsync,
} from '../fragments/message/user.ts';
import type { ContextStore, MessageData } from '../store/store.ts';
import { requireUserUIMessage } from '../ui-message-guards.ts';
import type {
  BaseWhenCtx,
  ReminderTargetHandler,
} from './reminder-target-handler.ts';

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

  async evaluateReminders(handlers: ReminderTargetHandler[]): Promise<this> {
    const conditional = this.#fragments.filter(isConditionalReminder);
    if (conditional.length === 0) return this;

    const configsByTarget = new Map<ReminderTarget, ConditionalReminder[]>();
    for (const fragment of conditional) {
      const config = fragment.metadata.reminder;
      const target = config.target;
      const list = configsByTarget.get(target) ?? [];
      list.push(config);
      configsByTarget.set(target, list);
    }

    const chain = await this.#engine.getChainSummary();
    const base = this.#engine.buildBaseWhenCtx(chain);
    const sharedUserMessage = this.#encodePendingUserMessage();

    for (const handler of handlers) {
      const configs = configsByTarget.get(handler.target);
      if (!configs || configs.length === 0) continue;

      const prepared = handler.prepare({
        pending: this.#pending,
        base,
        chain,
        sharedUserMessage,
      });
      if (!prepared) continue;

      const whenResults = await Promise.all(
        configs.map((config) => config.when(prepared.whenCtx)),
      );
      const fired = configs.filter((_, i) => whenResults[i]);
      if (fired.length === 0) continue;

      const resolvedOrNull = await Promise.all(
        fired.map((config) => resolveReminderAsync(config, prepared.whenCtx)),
      );
      const matched: Array<{
        config: ConditionalReminder;
        resolved: ReminderResolution;
      }> = [];
      for (let i = 0; i < resolvedOrNull.length; i++) {
        const resolution = resolvedOrNull[i];
        if (resolution)
          matched.push({ config: fired[i], resolved: resolution });
      }
      if (matched.length === 0) continue;

      handler.apply({
        pending: this.#pending,
        carrier: prepared.carrier,
        fired: matched.map((m) => m.config),
        resolved: matched.map((m) => m.resolved),
      });
    }

    return this;
  }

  #encodePendingUserMessage(): (UIMessage & { role: 'user' }) | undefined {
    const fragmentIndex = this.#pending.findLastIndex(
      (fragment) => fragment.name === 'user',
    );
    if (fragmentIndex < 0) return undefined;
    const fragment = this.#pending[fragmentIndex];
    if (!fragment.codec) return undefined;
    return requireUserUIMessage(
      fragment.codec.encode(),
      `Pending user fragment "${fragment.name}"`,
    );
  }

  async persist(): Promise<SaveResult> {
    let parentId: string | null = this.#engine.getActiveBranch().headMessageId;
    const now = Date.now();

    for (const fragment of this.#pending) {
      if (!fragment.codec) {
        throw new Error(`Fragment "${fragment.name}" is missing codec.`);
      }

      const msgId = fragment.id ?? crypto.randomUUID();

      let msgParentId: string | null = parentId;
      if (!this.#shouldBranch && msgId === parentId) {
        const existing = await this.#engine.store.getMessage(msgId);
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

      await this.#engine.store.addMessage(messageData);
      parentId = messageData.id;
    }

    if (parentId === null) {
      throw new Error(
        'Pipeline persisted no messages but pending was not empty',
      );
    }
    await this.#engine.commitHead(parentId);
    return { headMessageId: parentId };
  }
}
