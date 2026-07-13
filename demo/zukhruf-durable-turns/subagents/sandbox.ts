import { InMemoryFs } from 'just-bash';

import { createBashTool, createVirtualSandbox } from '@deepagents/context';

/**
 * The specialist does not need the root turn's Docker workspace. A private
 * in-memory sandbox satisfies the agent contract without creating a second
 * container or leaking filesystem state between parent and child.
 */
export const subagentSandbox = await createBashTool({
  sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
});
