import { InMemoryFs } from 'just-bash';

import { createBashTool, createVirtualSandbox } from '@deepagents/context';

/**
 * One in-memory sandbox shared by both subagents. `agent()` requires a
 * sandbox, but these subagents never touch a filesystem — this virtual one
 * (whose bash tools go unused) satisfies the contract with zero Docker cost.
 */
export const subagentSandbox = await createBashTool({
  sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
});
