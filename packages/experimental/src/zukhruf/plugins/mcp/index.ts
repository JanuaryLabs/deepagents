import type { MCPClient } from '@ai-sdk/mcp';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';
import { modelToolNames } from './model-tool-names.ts';

/**
 * Connect once per runtime and contribute all of the server's AI SDK tools,
 * each named `mcp__<server>__<tool>` for the model.
 */
export function mcp(options: {
  name: string;
  connect: () => Promise<MCPClient>;
}): AgentPluginDefinition {
  return {
    name: options.name,
    create: () => ({
      async initialize() {
        await using resources = new AsyncDisposableStack();
        const client = resources.adopt(await options.connect(), (client) =>
          client.close(),
        );
        const tools = await client.tools();
        const lifetime = resources.move();
        return {
          tools: modelToolNames(options.name, tools),
          [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
        };
      },
    }),
  };
}
