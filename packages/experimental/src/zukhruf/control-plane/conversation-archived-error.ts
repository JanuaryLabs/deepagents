/** A turn for a conversation whose tree is archived, or a second archive of it: unarchive it first. */
export class ConversationArchivedError extends Error {
  override readonly name = 'ConversationArchivedError';
  readonly chatId: string;

  constructor(chatId: string) {
    super(`chat "${chatId}" is archived`);
    this.chatId = chatId;
  }
}

/** An unarchive of a conversation that is not archived. */
export class ConversationNotArchivedError extends Error {
  override readonly name = 'ConversationNotArchivedError';
  readonly chatId: string;

  constructor(chatId: string) {
    super(`chat "${chatId}" is not archived`);
    this.chatId = chatId;
  }
}
