import { z } from 'zod';

import {
  type InterAgentCommunication,
  InterAgentCommunicationTypes,
} from './types.ts';

const conversationIdSchema = z.object({
  chatId: z.string(),
  userId: z.string(),
});

/** One `InterAgentCommunication` as a mailbox store persists it. */
export const communicationSchema = z.object({
  id: z.string(),
  type: z.enum(InterAgentCommunicationTypes),
  author: conversationIdSchema,
  recipient: conversationIdSchema,
  otherRecipients: z.array(conversationIdSchema),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  triggerTurn: z.boolean(),
}) satisfies z.ZodType<InterAgentCommunication>;
