import type { Tool, ToolSet } from 'ai';

import type { ResolvedMultiAgentHostConfig } from '../multi-agent-config.ts';
import { interruptAgentTool } from './interrupt-agent.ts';
import { listAgentsTool } from './list-agents.ts';
import { followupTaskTool, sendMessageTool } from './message-tools.ts';
import { createSpawnAgentTool } from './spawn-agent.ts';
import { createWaitAgentTool } from './wait-agent.ts';

const NAMESPACE_DESCRIPTION = 'Tools for spawning and managing sub-agents.';

export function createCollaborationTools(config: ResolvedMultiAgentHostConfig) {
  return {
    spawn_agent: configureTool(
      createSpawnAgentTool({ usageHintText: config.usageHintText }),
      config,
    ),
    send_message: configureTool(sendMessageTool, config),
    followup_task: configureTool(followupTaskTool, config),
    list_agents: configureTool(listAgentsTool, config),
    wait_agent: configureTool(
      createWaitAgentTool({
        minTimeoutMs: config.minWaitTimeoutMs,
        defaultTimeoutMs: config.defaultWaitTimeoutMs,
        maxTimeoutMs: config.maxWaitTimeoutMs,
      }),
      config,
    ),
    interrupt_agent: configureTool(interruptAgentTool, config),
  } satisfies ToolSet;
}

function configureTool<TOOL extends Tool>(
  collaborationTool: TOOL,
  config: ResolvedMultiAgentHostConfig,
) {
  const openai = collaborationTool.providerOptions?.openai;
  return {
    ...collaborationTool,
    providerOptions: {
      ...collaborationTool.providerOptions,
      ...(config.toolNamespace === undefined
        ? {}
        : {
            openai: {
              ...(typeof openai === 'object' && openai !== null ? openai : {}),
              namespace: {
                name: config.toolNamespace,
                description: NAMESPACE_DESCRIPTION,
              },
            },
          }),
    },
    metadata: {
      ...collaborationTool.metadata,
      zukhruf: {
        kind: 'collaboration',
      },
    },
  };
}
