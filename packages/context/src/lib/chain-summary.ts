import type { UIMessage } from 'ai';

import type { ContextFragment } from './fragments.ts';
import {
  getReminderOnceIds,
  isSyntheticReminderMessage,
} from './fragments/reminders/index.ts';
import type { MessageData } from './store/store.ts';
import { isUIMessage, requireUIMessage } from './ui-message-guards.ts';

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

/** Summarize a branch's stored message chain and the messages not saved yet. */
export function summarizeChain(
  stored: readonly MessageData[],
  pending: readonly ContextFragment[],
): ChainSummary {
  let turn = 0;
  let lastMessageAt: number | undefined;
  let lastMessage: UIMessage | undefined;
  const assistantMessages: UIMessage[] = [];
  // Segments produced after the same real user message belong to one reply.
  let reply: UIMessage[] = [];
  const replies = [reply];
  const firedOnceIds = new Set<string>();

  for (const msg of stored) {
    if (msg.name === 'assistant') {
      const message = requireUIMessage(
        msg.data,
        `Stored assistant message "${msg.id}"`,
      );
      assistantMessages.push(message);
      reply.push(message);
      continue;
    }

    if (msg.name !== 'user') continue;

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
        firedOnceIds.add(id);
      }
      continue;
    }

    // Real user turns carry the once-ids of any user-target reminder folded
    // into them, so a fresh engine re-collects them and once() stays latched.
    for (const id of getReminderOnceIds(message)) firedOnceIds.add(id);

    turn++;
    lastMessageAt = msg.createdAt;
    lastMessage = message;
    // The next assistant segment opens a NEW reply. Synthetic reminder users
    // continue above, so a mid-turn reminder never splits one reply into two.
    reply = [];
    replies.push(reply);
  }

  for (const fragment of pending) {
    if (fragment.name !== 'user') continue;
    const encoded = fragment.codec?.encode();
    if (isUIMessage(encoded) && isSyntheticReminderMessage(encoded)) continue;
    turn++;
  }

  return {
    turn,
    messageCount: stored.length + pending.length,
    lastMessageAt,
    lastMessage,
    lastAssistantMessage: assistantMessages.at(-1),
    lastAssistantMessages: assistantMessages,
    lastAssistantReplies: replies
      .filter((segments) => segments.length > 0)
      .map(mergeReply),
    firedOnceIds,
  };
}
