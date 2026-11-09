import { InMemoryFs } from 'just-bash';

import {
  type AgentSandbox,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

export async function buildSandbox(): Promise<AgentSandbox> {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}
