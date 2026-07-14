import type { UIMessage } from 'ai';

import type { ContextFragment } from './fragments.ts';
import {
  getReminderOnceIds,
  isSyntheticReminderMessage,
} from './fragments/reminders/index.ts';
import type { MessageData } from './store/store.ts';
import { requireUIMessage } from './ui-message-guards.ts';

export interface ChainSummary {
  turn: number;
  messageCount: number;
  lastMessageAt?: number;
  lastMessage?: UIMessage;
  lastAssistantMessage?: UIMessage;
  lastAssistantMessages?: UIMessage[];
  /**
   * One entry per assistant REPLY: the segments a reply was carved into by
   * firing reminders, merged back together. A reply is everything the assistant
   * produced in answer to one real user message (synthetic reminder users do
   * not open a new reply). Window predicates count these, so their answer does
   * not change when an unrelated reminder starts firing.
   */
  lastAssistantReplies?: UIMessage[];
  firedOnceIds: Set<string>;
}

/** Merge the segments of one reply back into the message the user would see. */
function mergeReply(segments: UIMessage[]): UIMessage {
  const [first] = segments;
  return {
    ...first,
    parts: segments.flatMap((segment) => segment.parts),
  };
}

export class ChainSummaryBuilder {
  #turn = 0;
  #messageCount = 0;
  #lastMessageAt?: number;
  #lastMessage?: UIMessage;
  #lastAssistantMessage?: UIMessage;
  #lastAssistantMessages: UIMessage[] = [];
  #replies: UIMessage[][] = [];
  #replyClosed = true;
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
      // Segments produced after the same real user message belong to one reply.
      const open = this.#replies.at(-1);
      if (open && !this.#replyClosed) open.push(message);
      else {
        this.#replies.push([message]);
        this.#replyClosed = false;
      }
      return;
    }

    if (msg.name !== 'user') {
      return;
    }

    const message = requireUIMessage(
      msg.data,
      `Stored user message "${msg.id}"`,
    );
    // Synthetic reminder users are model-only nudges, never conversation turns:
    // they advance neither turn nor lastMessageAt (elapsed measures from the
    // last real user message). Their persisted once-ids are the durable record
    // that lets once() suppress a fire-once reminder across runs.
    if (isSyntheticReminderMessage(message)) {
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
    // The next assistant segment opens a NEW reply. Synthetic reminder users
    // return above, so a mid-turn reminder never splits one reply into two.
    this.#replyClosed = true;
  }

  ingestPending(fragment: ContextFragment): void {
    this.#messageCount++;
    if (fragment.name !== 'user') return;
    const encoded = fragment.codec?.encode();
    if (encoded && isSyntheticReminderMessage(encoded as UIMessage)) return;
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
      lastAssistantReplies: this.#replies.map(mergeReply),
      firedOnceIds: this.#firedOnceIds,
    };
  }
}
