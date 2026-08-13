import { tool } from 'ai';
import { z } from 'zod';

import { agent, chat, structuredOutput } from '@deepagents/context';

type BaseContext = {
  actor: string;
};

type RequiredContext = BaseContext & {
  coordinator: string;
};

const contextualTool = tool<Record<string, never>, string, RequiredContext>({
  inputSchema: z.object({}).strict(),
  execute: async (_input, { context }) => context.coordinator,
});

const tools = { contextualTool };
type Sandbox = Parameters<typeof agent<typeof tools>>[0]['sandbox'];

function verifyToolContextContract(
  sandbox: Sandbox,
  baseContext: BaseContext,
  requiredContext: RequiredContext,
) {
  const plainAgent = agent({
    name: 'plain',
    sandbox,
  });

  plainAgent.generate();
  plainAgent.stream();
  chat(plainAgent);

  const validAgent = agent({
    name: 'valid',
    sandbox,
    tools,
  });
  const toolsContext = { contextualTool: requiredContext };

  validAgent.generate({ toolsContext });

  // @ts-expect-error Contextual tools keep their context required.
  validAgent.generate();

  validAgent.generate({
    // @ts-expect-error Agent calls keep the context selected at construction.
    toolsContext: { contextualTool: baseContext },
  });

  chat(validAgent, { toolsContext });

  // @ts-expect-error chat requires the context inferred from the agent tools.
  chat(validAgent, { toolsContext: { contextualTool: baseContext } });

  // @ts-expect-error chat never fabricates a missing tool context.
  chat(validAgent);

  const subagentTools = { subagent: validAgent.asTool() };
  const validParent = agent({
    name: 'valid-parent',
    sandbox,
    tools: subagentTools,
  });

  validParent.generate({ toolsContext: { subagent: toolsContext } });

  validParent.generate({
    // @ts-expect-error asTool propagates its agent's required context.
    toolsContext: { subagent: { contextualTool: baseContext } },
  });

  const outputSchema = z.object({ value: z.string() });
  const plainOutput = structuredOutput({ schema: outputSchema });
  plainOutput.generate();
  plainOutput.stream();

  const validOutput = structuredOutput({
    schema: outputSchema,
    tools,
  });

  validOutput.generate({ toolsContext });

  // @ts-expect-error Contextual structured output tools require context.
  validOutput.generate();

  validOutput.generate({
    // @ts-expect-error Structured output infers the same tool context contract.
    toolsContext: { contextualTool: baseContext },
  });
}

void verifyToolContextContract;
