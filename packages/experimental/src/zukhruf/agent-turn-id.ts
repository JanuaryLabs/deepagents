import { v5 as uuidv5 } from 'uuid';

import type { ConversationId } from './mailbox/types.ts';

/** Conversation-scoped durable identity for one caller-supplied turn key. */
export class AgentTurnId {
  static readonly #prefix = 'zukhruf-turn';
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static fromRequest(
    conversation: ConversationId,
    requestId: string,
  ): AgentTurnId {
    if (!requestId.trim()) {
      throw new Error('turn id cannot be empty');
    }
    const scope = conversationNamespace(conversation);
    return new AgentTurnId(
      `${AgentTurnId.#prefix}:${scope}:${uuidv5(requestId, scope)}`,
    );
  }

  static random(conversation: ConversationId): AgentTurnId {
    return AgentTurnId.fromRequest(conversation, crypto.randomUUID());
  }

  static assertOwner(conversation: ConversationId, streamId: string): void {
    const expectedPrefix = `${AgentTurnId.#prefix}:${conversationNamespace(conversation)}:`;
    if (!streamId.startsWith(expectedPrefix)) {
      throw new Error(
        `stream "${streamId}" does not belong to conversation "${conversation.chatId}"`,
      );
    }
  }

  toString(): string {
    return this.#value;
  }
}

export function conversationNamespace(conversation: ConversationId): string {
  if (!conversation.chatId.trim() || !conversation.userId.trim()) {
    throw new Error('conversation requires non-empty chatId and userId');
  }
  return uuidv5(
    JSON.stringify([conversation.userId, conversation.chatId]),
    uuidv5.URL,
  );
}
