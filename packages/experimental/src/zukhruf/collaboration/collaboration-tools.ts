import type { Tool } from 'ai';

import type { ResolvedMultiAgentHostConfig } from '../multi-agent-config.ts';
import { interruptAgentTool } from './interrupt-agent.ts';
import { listAgentsTool } from './list-agents.ts';
import { followupTaskTool, sendMessageTool } from './message-tools.ts';
import { createSpawnAgentTool } from './spawn-agent.ts';
import type { ToolExposure } from './tool-exposure.ts';
import { createWaitAgentTool } from './wait-agent.ts';

export function createCollaborationSurface(
  config: ResolvedMultiAgentHostConfig,
) {
  return config.exposure.surface({
    spawn_agent: configureTool(
      createSpawnAgentTool({ usageHintText: config.usageHintText }),
      config.exposure,
    ),
    send_message: configureTool(sendMessageTool, config.exposure),
    followup_task: configureTool(followupTaskTool, config.exposure),
    wait_agent: configureTool(
      createWaitAgentTool({
        minTimeoutMs: config.minWaitTimeoutMs,
        defaultTimeoutMs: config.defaultWaitTimeoutMs,
        maxTimeoutMs: config.maxWaitTimeoutMs,
      }),
      config.exposure,
    ),
    interrupt_agent: configureTool(interruptAgentTool, config.exposure),
    list_agents: configureTool(listAgentsTool, config.exposure),
  });
}

function configureTool<TOOL extends Tool>(
  collaborationTool: TOOL,
  exposure: ToolExposure,
) {
  return exposure.tool({
    ...collaborationTool,
    metadata: {
      ...collaborationTool.metadata,
      zukhruf: {
        kind: 'collaboration',
      },
    },
  });
}
