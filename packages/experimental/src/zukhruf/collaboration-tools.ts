import type { Tool, ToolSet } from 'ai';

import { interruptAgentTool } from './interrupt-agent.ts';
import { listAgentsTool } from './list-agents.ts';
import { followupTaskTool, sendMessageTool } from './message-tools.ts';
import type { ResolvedMultiAgentV2HostConfig } from './multi-agent-v2-config.ts';
import { createSpawnAgentTool } from './spawn-agent.ts';
import { createWaitAgentTool } from './wait-agent.ts';

const NAMESPACE_DESCRIPTION = 'Tools for spawning and managing sub-agents.';

export function createCollaborationTools(
  config: ResolvedMultiAgentV2HostConfig,
): ToolSet {
  const tools: ToolSet = {
    spawn_agent: createSpawnAgentTool({
      usageHintText: config.usageHintText,
    }),
    send_message: sendMessageTool,
    followup_task: followupTaskTool,
    list_agents: listAgentsTool,
    wait_agent: createWaitAgentTool({
      minTimeoutMs: config.minWaitTimeoutMs,
      defaultTimeoutMs: config.defaultWaitTimeoutMs,
      maxTimeoutMs: config.maxWaitTimeoutMs,
    }),
    interrupt_agent: interruptAgentTool,
  };

  return Object.fromEntries(
    Object.entries(tools).map(([name, collaborationTool]) => [
      name,
      configureTool(collaborationTool, config),
    ]),
  );
}

function configureTool(
  collaborationTool: Tool,
  config: ResolvedMultiAgentV2HostConfig,
): Tool {
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
        codeModeExposure: 'direct-model-only',
      },
    },
  };
}
