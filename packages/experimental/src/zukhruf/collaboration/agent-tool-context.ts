import type {
  AgentActor,
  AgentControlPlane,
} from '../control-plane/agent-control-plane.ts';

export type AgentToolContext = {
  controlPlane: AgentControlPlane;
  actor: AgentActor;
};
