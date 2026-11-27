import type { TurnRef } from '../queue/turn-queue.ts';

/** A user's submitted question, carried by the queue until its worker records it in the chain. */
export type UserQuestion = Extract<TurnRef, { kind: 'message' }> & {
  message: { role: 'user' };
  trigger: 'submit-message';
};

/** A regenerate or a continuation already has its input in the chain, and a mailbox wake keeps its mail in the MailboxStore. */
export function isUserQuestion(turn: TurnRef): turn is UserQuestion {
  return (
    turn.kind === 'message' &&
    turn.message.role === 'user' &&
    turn.trigger === 'submit-message'
  );
}
