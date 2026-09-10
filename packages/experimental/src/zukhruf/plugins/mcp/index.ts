import type { MCPClient } from '@ai-sdk/mcp';

import type { AgentPluginDefinition } from '../../runtime/agent-runtime.ts';

/** Connect once per runtime and contribute all of the server's AI SDK tools. */
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
          tools,
          [Symbol.asyncDispose]: () => lifetime.disposeAsync(),
        };
      },
    }),
  };
}
