/** A turn id the conversation never issued reads as absent, so another conversation's turn is never confirmed. */
export class TurnNotFoundError extends Error {
  override readonly name = 'TurnNotFoundError';
  readonly turnId: string;

  constructor(turnId: string) {
    super(`turn "${turnId}" does not exist`);
    this.turnId = turnId;
  }
}
