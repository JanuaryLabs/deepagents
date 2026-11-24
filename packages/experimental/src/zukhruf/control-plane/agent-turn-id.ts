import { v5 as uuidv5, validate as validateUuid } from 'uuid';
import { z } from 'zod';

import type { ConversationId } from '../mailbox/types.ts';
import { TurnNotFoundError } from './turn-not-found-error.ts';

const prefix = 'zukhruf-turn';

/** The shape of every AgentTurnId string; AgentTurnId.assertOwner checks whose it is. */
export const agentTurnIdSchema = z.string().refine((value) => {
  const [head, scope, turn, ...rest] = value.split(':');
  return (
    head === prefix &&
    rest.length === 0 &&
    validateUuid(scope) &&
    validateUuid(turn)
  );
});

/** Conversation-scoped durable identity for one caller-supplied turn key. */
export class AgentTurnId {
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
    return new AgentTurnId(`${prefix}:${scope}:${uuidv5(requestId, scope)}`);
  }

  static random(conversation: ConversationId): AgentTurnId {
    return AgentTurnId.fromRequest(conversation, crypto.randomUUID());
  }

  /** What every turn id of `conversation` starts with, and no other conversation's does. */
  static prefixOf(conversation: ConversationId): string {
    return `${prefix}:${conversationNamespace(conversation)}:`;
  }

  static assertOwner(conversation: ConversationId, streamId: string): void {
    if (!streamId.startsWith(AgentTurnId.prefixOf(conversation))) {
      throw new TurnNotFoundError(streamId);
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
