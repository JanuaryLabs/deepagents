import type { ConversationId, InterAgentCommunication } from './types.ts';

export interface MailboxEnqueueResult {
  recipientActive: boolean;
}

export interface MailboxEndTurnResult {
  hasPending: boolean;
  turnEnded: boolean;
}

/** Durable pending-mail storage. This is deliberately not an execution queue. */
export abstract class MailboxStore {
  abstract beginTurn(recipient: ConversationId, turnId: string): Promise<void>;

  abstract enqueue(
    communication: InterAgentCommunication,
  ): Promise<MailboxEnqueueResult>;

  abstract endTurn(
    recipient: ConversationId,
    turnId: string,
  ): Promise<MailboxEndTurnResult>;

  abstract hasPending(recipient: ConversationId): Promise<boolean>;

  /** Whether undelivered mail sent with `MessageDeliveryModes.TriggerTurn` waits for the recipient. */
  abstract hasPendingTriggerTurn(recipient: ConversationId): Promise<boolean>;

  /** Consumes the contiguous queue-only prefix, stopping before the first trigger. */
  abstract drainLeadingQueueOnly(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]>;

  /** Draining is consumption: removes and returns all pending mail in FIFO order. */
  abstract drain(recipient: ConversationId): Promise<InterAgentCommunication[]>;

  /** Removes the recipient's pending mail and its turn activity, as deleting its chat does. */
  abstract forget(recipient: ConversationId): Promise<void>;
}

/** The part of the mailbox that writes inside a caller's transaction. */
export type TransactionalMailboxStore = Pick<
  MailboxStore,
  'enqueue' | 'beginTurn' | 'hasPendingTriggerTurn' | 'forget'
>;
