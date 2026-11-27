/** A session title that is empty once trimmed. */
export class EmptySessionTitleError extends Error {
  override readonly name = 'EmptySessionTitleError';
  readonly chatId: string;

  constructor(chatId: string) {
    super(`chat "${chatId}" cannot take an empty title`);
    this.chatId = chatId;
  }
}
