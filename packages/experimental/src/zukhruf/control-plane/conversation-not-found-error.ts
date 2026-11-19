import type { ConversationId } from '../mailbox/types.ts';

/** A conversation the caller does not own reads as absent, so its owner never leaks. */
export class ConversationNotFoundError extends Error {
  override readonly name = 'ConversationNotFoundError';
  readonly chatId: string;

  constructor(chatId: string) {
    super(`chat "${chatId}" does not exist`);
    this.chatId = chatId;
  }
}

export function assertConversationOwner(
  conversation: ConversationId,
  storedUserId: string,
): void {
  if (storedUserId !== conversation.userId) {
    throw new ConversationNotFoundError(conversation.chatId);
  }
}
