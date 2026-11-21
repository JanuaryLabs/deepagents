import type { Capability, Guidance, Role, ToolNamer } from './capability.ts';
import { createSpawnAgentTool } from './spawn-agent.ts';

/** Creates agents: `spawn_agent`. Every other capability acts on its agents. */
export class Spawning implements Capability {
  readonly tools;

  /** `usageHintText` is appended to the `spawn_agent` description. */
  constructor({ usageHintText }: { usageHintText?: string } = {}) {
    this.tools = { spawn_agent: createSpawnAgentTool({ usageHintText }) };
  }

  guidance(role: Role, name: ToolNamer): Guidance {
    const spawnAgent = `\`${name('spawn_agent')}\``;
    if (role === 'root') {
      return {
        intro:
          'At the start of your turn, you are the active agent. You can spawn sub-agents to handle subtasks, and those agents can recursively spawn their own declared sub-agents. All agents are equally capable and receive the tools declared for their agent type.',
        uses: [`${spawnAgent} to create an agent`],
        notes:
          'You can decide how much context you want to propagate to your sub-agents with the `fork_turns` parameter.',
      };
    }
    return {
      intro:
        'You can spawn declared sub-agents recursively. All agents are equally capable and receive the tools declared for their agent type.',
      uses: [`${spawnAgent} to create one`],
    };
  }
}
