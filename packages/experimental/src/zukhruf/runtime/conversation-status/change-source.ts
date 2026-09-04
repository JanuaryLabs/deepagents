import type { ConversationId } from '../../mailbox/types.ts';

/**
 * Cross-process wake hints for conversation status.
 *
 * A hint names a conversation whose status may have changed; it carries no
 * status, because `observe(conversation).conversationStatus()` is the
 * authority in every process and a stale or reordered payload would not be.
 */
export interface ConversationStatusChangeSource {
  notify(conversation: ConversationId): Promise<void>;
  subscribe(
    signal: AbortSignal,
  ): Promise<AsyncIterable<ConversationStatusChangeHint>>;
}

export type ConversationStatusChangeHint =
  { type: 'change'; conversation: ConversationId } | { type: 'reset' };
