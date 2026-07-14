import { randomUUID } from 'node:crypto';

/** Durable thread identity; AgentPath is its model-facing address. */
export interface ConversationId {
  chatId: string;
  userId: string;
}

export const MessageDeliveryMode = {
  QueueOnly: 'queue-only',
  TriggerTurn: 'trigger-turn',
} as const;

export type MessageDeliveryMode =
  (typeof MessageDeliveryMode)[keyof typeof MessageDeliveryMode];

export const InterAgentCommunicationType = {
  Message: 'MESSAGE',
  NewTask: 'NEW_TASK',
  FinalAnswer: 'FINAL_ANSWER',
} as const;

export type InterAgentCommunicationType =
  (typeof InterAgentCommunicationType)[keyof typeof InterAgentCommunicationType];

/** A model-visible message sent from one independent agent thread to another. */
export interface InterAgentCommunication {
  id: string;
  type: InterAgentCommunicationType;
  author: ConversationId;
  recipient: ConversationId;
  otherRecipients: ConversationId[];
  content: string;
  metadata?: Record<string, unknown>;
  triggerTurn: boolean;
}

export type NewInterAgentCommunication = Omit<
  InterAgentCommunication,
  'id' | 'otherRecipients' | 'triggerTurn' | 'type'
> & {
  id?: string;
  otherRecipients?: ConversationId[];
  type?: InterAgentCommunicationType;
};

export function createInterAgentCommunication(
  communication: NewInterAgentCommunication,
): InterAgentCommunication {
  const value: InterAgentCommunication = {
    ...communication,
    id: communication.id ?? randomUUID(),
    type: communication.type ?? InterAgentCommunicationType.Message,
    otherRecipients: communication.otherRecipients ?? [],
    triggerTurn: false,
  };
  assertCommunication(value);
  return value;
}

export function assertCommunication(
  communication: InterAgentCommunication,
): void {
  if (!communication.id.trim()) {
    throw new Error('inter-agent communication id cannot be empty');
  }
  if (
    !Object.values(InterAgentCommunicationType).includes(communication.type)
  ) {
    throw new Error('inter-agent communication type is invalid');
  }
  assertConversationId(communication.author, 'author');
  assertConversationId(communication.recipient, 'recipient');
  for (const recipient of communication.otherRecipients) {
    assertConversationId(recipient, 'other recipient');
  }
  if (!communication.content.trim()) {
    throw new Error('inter-agent communication content cannot be empty');
  }
}

function assertConversationId(value: ConversationId, label: string): void {
  if (!value.chatId.trim() || !value.userId.trim()) {
    throw new Error(
      `inter-agent communication ${label} requires chatId and userId`,
    );
  }
}
