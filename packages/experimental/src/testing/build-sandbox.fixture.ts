import { InMemoryFs } from 'just-bash';

import {
  type BashToolkit,
  type DisposableSandbox,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

export async function buildSandbox(): Promise<BashToolkit<DisposableSandbox>> {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}
