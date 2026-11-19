/** An assistant continuation (an approval answer) for a turn the conversation has moved past. */
export class StaleTurnError extends Error {
  override readonly name = 'StaleTurnError';
  readonly turnId: string;

  constructor(turnId: string) {
    super(`turn "${turnId}" is not the latest turn`);
    this.turnId = turnId;
  }
}
