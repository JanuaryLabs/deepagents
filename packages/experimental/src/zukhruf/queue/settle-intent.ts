import type { ConversationId } from '../mailbox/types.ts';

/** A settle follow-up still owed to one turn of a conversation, once that turn has settled. */
export interface SettleIntent {
  conversation: ConversationId;
  turnId: string;
}

/**
 * The intents of one settle follow-up, on a queue of its own: only a process
 * that runs the follow-up consumes it. A handler that throws has its intent
 * delivered again, with backoff, a bounded number of times.
 */
export interface SettleQueue {
  consume(
    handler: (intent: SettleIntent) => Promise<void>,
  ): Promise<AsyncDisposable>;
}

/** Records settle intents in a caller's unit: workers see them only once it commits. */
export interface TransactionalSettleIntents {
  /** Records `intent` for `followUp` as `id`; recording an id the queue still holds adds nothing. */
  record(followUp: string, id: string, intent: SettleIntent): Promise<void>;
}
