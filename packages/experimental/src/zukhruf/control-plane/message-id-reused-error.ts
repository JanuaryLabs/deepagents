/** A user message whose id an earlier turn of the session was admitted for with other content. */
export class MessageIdReusedError extends Error {
  override readonly name = 'MessageIdReusedError';
  readonly sessionId: string;
  readonly messageId: string;

  constructor(sessionId: string, messageId: string) {
    super(
      `message "${messageId}" of session "${sessionId}" was already submitted with other content`,
    );
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}
