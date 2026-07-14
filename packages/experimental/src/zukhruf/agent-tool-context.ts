import type { AgentActor, AgentControlPlane } from './agent-control-plane.ts';

export interface AgentToolContext extends Record<string, unknown> {
  controlPlane: AgentControlPlane;
  actor: AgentActor;
}
