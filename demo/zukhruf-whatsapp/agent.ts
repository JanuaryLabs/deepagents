import type { AgentModel } from '@deepagents/context';
import { defineAgent } from '@deepagents/experimental/zukhruf';

import { participantInstructions } from './instructions.ts';
import sandbox from './sandbox.ts';
import { replyToGroup } from './tools/reply-to-group.ts';

export interface WhatsAppParticipant {
  name: string;
  specialty: string;
  model: AgentModel;
}

export function createParticipantAgent(
  participant: WhatsAppParticipant,
  post: (message: string) => void,
) {
  return defineAgent({
    name: participant.name,
    model: participant.model,
    sandbox,
    instructions: participantInstructions(participant),
    tools: { reply_to_group: replyToGroup(post) },
  });
}
