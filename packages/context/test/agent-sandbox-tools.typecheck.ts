import { tool } from 'ai';
import { z } from 'zod';

import {
  type AgentSandbox,
  type BashToolkit,
  type BashToolkitTools,
  agent,
  chat,
  structuredOutput,
} from '@deepagents/context';

async function verifySandboxToolsContract(toolkit: BashToolkit) {
  const bashOnly = { tools: { bash: toolkit.bash }, sandbox: toolkit.sandbox };

  const bashAgent = agent({ name: 'bash-only', sandbox: bashOnly });
  await chat(bashAgent);
  void bashAgent.tools.bash;
  // @ts-expect-error A bash-only sandbox gives the model no readFile tool.
  void bashAgent.tools.readFile;
  agent({
    name: 'bash-only-choice',
    sandbox: bashOnly,
    // @ts-expect-error The model cannot be made to call a tool it does not have.
    toolChoice: { type: 'tool', toolName: 'writeFile' },
  });
  structuredOutput({ schema: z.object({}), sandbox: bashOnly });

  const toolkitAgent = agent({ name: 'toolkit', sandbox: toolkit });
  void toolkitAgent.tools.readFile;
  void toolkitAgent.tools.writeFile;
  agent({
    name: 'toolkit-choice',
    sandbox: toolkit,
    toolChoice: { type: 'tool', toolName: 'writeFile' },
  });

  const lookup = tool({
    inputSchema: z.object({}),
    execute: async () => 'found',
  });
  agent({
    name: 'host-tool-choice',
    sandbox: bashOnly,
    tools: { lookup },
    toolChoice: { type: 'tool', toolName: 'lookup' },
  });

  // @ts-expect-error A file tool caller needs readFile and writeFile.
  const withFileTools: AgentSandbox<BashToolkitTools> = bashOnly;
  // @ts-expect-error createBashTool's result always carries both file tools.
  const asToolkit: BashToolkit = { ...bashOnly, bash: toolkit.bash };
  void withFileTools;
  void asToolkit;

  const noBash = { tools: {}, sandbox: toolkit.sandbox };
  // @ts-expect-error Every agent sandbox shows the model bash.
  agent({ name: 'no-bash', sandbox: noBash });
}

void verifySandboxToolsContract;
