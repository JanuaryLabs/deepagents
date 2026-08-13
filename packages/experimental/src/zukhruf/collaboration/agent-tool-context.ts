import type {
  AgentActor,
  AgentControlPlane,
} from '../control-plane/agent-control-plane.ts';
import type { SchedulingCoordinator } from '../scheduling/coordinator.ts';

export type AgentToolContext = {
  controlPlane: AgentControlPlane;
  actor: AgentActor;
};

export type SchedulingToolContext = AgentToolContext & {
  schedulingCoordinator: SchedulingCoordinator;
};
