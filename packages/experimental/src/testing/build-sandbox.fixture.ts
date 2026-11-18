import { InMemoryFs } from 'just-bash';

import {
  type BashToolkit,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

export async function buildSandbox(): Promise<BashToolkit> {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}
