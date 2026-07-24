import { v5 as uuidv5 } from 'uuid';

import { conversationNamespace } from '../control-plane/agent-turn-id.ts';
import type { ConversationId } from '../mailbox/types.ts';

export function approvalJobId(
  conversation: ConversationId,
  approvalId: string,
): string {
  return uuidv5(`approval:${approvalId}`, conversationNamespace(conversation));
}
