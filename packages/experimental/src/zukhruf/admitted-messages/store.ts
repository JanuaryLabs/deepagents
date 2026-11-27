/**
 * The digest of the user message each turn was admitted for, written with
 * the turn's stream, so a resend of a message id can be told from a reuse of
 * it for other content in every status of the turn: the chain holds the
 * message only once the turn has run.
 */
export abstract class AdmittedMessageStore {
  /** The digest the turn `turnId` was admitted with, if it was admitted for a user message. */
  abstract digestOf(turnId: string): Promise<string | undefined>;

  /** Records the digest of the message the turn `turnId` of chat `chatId` was admitted for. */
  abstract record(
    turnId: string,
    chatId: string,
    digest: string,
  ): Promise<void>;

  /** Removes the digests of the turns of chat `chatId`. */
  abstract forget(chatId: string): Promise<void>;
}
