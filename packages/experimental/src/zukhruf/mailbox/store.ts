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

  /** Consumes the contiguous queue-only prefix, stopping before the first trigger. */
  abstract drainLeadingQueueOnly(
    recipient: ConversationId,
  ): Promise<InterAgentCommunication[]>;

  /** Draining is consumption: removes and returns all pending mail in FIFO order. */
  abstract drain(recipient: ConversationId): Promise<InterAgentCommunication[]>;
}
