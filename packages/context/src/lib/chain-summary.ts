import type { UIMessage } from 'ai';

import type { ContextFragment } from './fragments.ts';
import type { MessageData } from './store/store.ts';
import { requireUIMessage } from './ui-message-guards.ts';

export interface ChainSummary {
  turn: number;
  messageCount: number;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
}

export class ChainSummaryBuilder {
  #turn = 0;
  #messageCount = 0;
  #lastMessageAt?: number;
  #lastMessage?: UIMessage;
  #lastAssistantMessage?: UIMessage;
  #lastAssistantMessages: UIMessage[] = [];

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

    this.#turn++;
    this.#lastMessageAt = msg.createdAt;
    this.#lastMessage = requireUIMessage(
      msg.data,
      `Stored user message "${msg.id}"`,
    );
  }

  ingestPending(fragment: ContextFragment): void {
    this.#messageCount++;
    if (fragment.name === 'user') this.#turn++;
  }

  build(): ChainSummary {
    return {
      turn: this.#turn,
      messageCount: this.#messageCount,
      lastMessageAt: this.#lastMessageAt,
      lastMessage: this.#lastMessage,
      lastAssistantMessage: this.#lastAssistantMessage,
      lastAssistantMessages: this.#lastAssistantMessages,
    };
  }
}
