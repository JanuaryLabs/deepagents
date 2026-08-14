import type {
  AgentActor,
  AgentControlPlane,
} from '../control-plane/agent-control-plane.ts';
import type { ConversationScheduler } from '../scheduling/conversation-scheduler.ts';

export type AgentToolContext = {
  controlPlane: AgentControlPlane;
  actor: AgentActor;
};

export type SchedulingToolContext = AgentToolContext & {
  conversationScheduler: ConversationScheduler;
};
