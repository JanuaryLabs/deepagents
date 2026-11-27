import type { UIMessage } from 'ai';

import type { StreamData, StreamStatus } from '@deepagents/context';

import { AgentTurnId } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';
import { isModelOnlyMessage } from './content-kind.ts';
import type { ConversationStatus } from './conversation-status/projector.ts';

/** Codex's `TurnStatus` wire values (`app-server-protocol/src/protocol/v2/turn.rs`). */
export type SessionTurnStatus =
  'completed' | 'interrupted' | 'failed' | 'inProgress';

/** One turn of the session read, as Codex's `Turn`: its items are the `messages` whose ids it lists. */
export interface SessionTurn {
  readonly turnId: string;
  readonly status: SessionTurnStatus;
  readonly messageIds: readonly string[];
  /** The stream's error; only a failed turn has one. */
  readonly error?: string;
}

/**
 * What a UI reads of a session, as Codex's `thread/read`: the messages a
 * person sees, without the user messages written for the model only, and each
 * turn's status, so an interrupted turn draws as a notice.
 */
export interface SessionRead {
  readonly messages: UIMessage[];
  readonly turns: readonly SessionTurn[];
  readonly status: ConversationStatus;
  /** When the session was archived; absent while it is not. */
  readonly archivedAt?: number;
}

interface OpenTurn {
  readonly turnId: string;
  readonly messageIds: string[];
}

const turnStatusOf: Record<StreamStatus, SessionTurnStatus> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'interrupted',
  running: 'inProgress',
  // A stream that is queued while its turn already holds messages was reopened, by a regenerate or an approval continuation.
  queued: 'inProgress',
};

/**
 * Groups the chain into turns and drops the model-only user messages. A user
 * message opens its turn (the turn id comes from the message id, as enqueue
 * derives it); an assistant message whose id is another turn id of the
 * conversation opens that turn (a mailbox wake has no user message); any
 * other assistant message joins the open turn. A turn's assistant
 * placeholder with no parts yet is not a message to show.
 */
export function projectSession(
  conversation: ConversationId,
  chain: readonly UIMessage[],
  streams: ReadonlyMap<string, Pick<StreamData, 'status' | 'error'>>,
): Pick<SessionRead, 'messages' | 'turns'> {
  const prefix = AgentTurnId.prefixOf(conversation);
  const messages: UIMessage[] = [];
  const opened: OpenTurn[] = [];
  for (const message of chain) {
    if (message.role === 'user') {
      if (isModelOnlyMessage(message)) continue;
      opened.push({
        turnId: AgentTurnId.fromRequest(conversation, message.id).toString(),
        messageIds: [],
      });
    } else if (
      message.role === 'assistant' &&
      message.id.startsWith(prefix) &&
      message.id !== opened.at(-1)?.turnId
    ) {
      opened.push({ turnId: message.id, messageIds: [] });
    }
    if (message.role === 'assistant' && message.parts.length === 0) continue;
    messages.push(message);
    opened.at(-1)?.messageIds.push(message.id);
  }
  return {
    messages,
    turns: opened.map(({ turnId, messageIds }) => {
      const stream = streams.get(turnId);
      // A turn with no stream row was forked from the parent's history.
      if (!stream) return { turnId, status: 'completed', messageIds };
      return {
        turnId,
        status: turnStatusOf[stream.status],
        messageIds,
        ...(stream.status === 'failed' && stream.error !== null
          ? { error: stream.error }
          : {}),
      };
    }),
  };
}
