import type { Capability, Guidance } from './capability.ts';
import { interruptAgentTool } from './interrupt-agent.ts';
import { listAgentsTool } from './list-agents.ts';

/** Watches and stops agents: `interrupt_agent` and `list_agents`. */
export class Supervision implements Capability {
  readonly tools = {
    interrupt_agent: interruptAgentTool,
    list_agents: listAgentsTool,
  };

  guidance(): Guidance {
    return {};
  }
}
