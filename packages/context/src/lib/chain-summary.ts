import type { UIMessage } from 'ai';

import type { ContextFragment } from './fragments.ts';
import {
  getReminderOnceIds,
  isSyntheticSteerMessage,
} from './fragments/message/user.ts';
import type { MessageData } from './store/store.ts';
import { requireUIMessage } from './ui-message-guards.ts';

export interface ChainSummary {
  turn: number;
  messageCount: number;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
  firedOnceIds: Set<string>;
}

export class ChainSummaryBuilder {
  #turn = 0;
  #messageCount = 0;
  #lastMessageAt?: number;
  #lastMessage?: UIMessage;
  #lastAssistantMessage?: UIMessage;
  #lastAssistantMessages: UIMessage[] = [];
  #firedOnceIds = new Set<string>();

  ingestStored(msg: MessageData): void {
    this.#messageCount++;

    if (msg.name === 'assistant') {
      const message = requireUIMessage(
        msg.data,
        `Stored assistant message "${msg.id}"`,
      );
      this.#lastAssistantMessage = message;
      this.#lastAssistantMessages.push(message);
      return;
    }

    if (msg.name !== 'user') {
      return;
    }

    const message = requireUIMessage(
      msg.data,
      `Stored user message "${msg.id}"`,
    );
    // Synthetic steer users are mid-loop nudges, never conversation turns:
    // they advance neither turn nor lastMessageAt (elapsed measures from the
    // last real user message). Their persisted once-ids are the durable record
    // that lets once() suppress a fire-once reminder across runs.
    if (isSyntheticSteerMessage(message)) {
      for (const id of message.metadata.synthetic.onceIds ?? []) {
        this.#firedOnceIds.add(id);
      }
      return;
    }

    // Real user turns carry the once-ids of any user-target reminder folded
    // into them, so a fresh engine re-collects them and once() stays latched.
    for (const id of getReminderOnceIds(message)) this.#firedOnceIds.add(id);

    this.#turn++;
    this.#lastMessageAt = msg.createdAt;
    this.#lastMessage = message;
  }

  ingestPending(fragment: ContextFragment): void {
    this.#messageCount++;
    if (fragment.name !== 'user') return;
    const encoded = fragment.codec?.encode();
    if (encoded && isSyntheticSteerMessage(encoded as UIMessage)) return;
    this.#turn++;
  }

  build(): ChainSummary {
    return {
      turn: this.#turn,
      messageCount: this.#messageCount,
      lastMessageAt: this.#lastMessageAt,
      lastMessage: this.#lastMessage,
      lastAssistantMessage: this.#lastAssistantMessage,
      lastAssistantMessages: this.#lastAssistantMessages,
      firedOnceIds: this.#firedOnceIds,
    };
  }
}
