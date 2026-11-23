import type { ConversationId } from '../mailbox/types.ts';

/** A due stop of a chat's sandbox, armed when the chat went idle. */
export interface SandboxIdleWake {
  conversation: ConversationId;
  /** The chat's lastTurnId when it went idle; null before any turn. */
  turnId: string | null;
  /** When the stop is due, in epoch milliseconds: the wake's runAt. */
  scheduledFor: number;
}
