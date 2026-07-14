import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

/**
 * Each independent subagent chat gets its own lightweight sandbox instance.
 * These agents use model-hosted tools and never touch a real filesystem.
 */
export const subagentSandbox = defineSandbox(() =>
  createVirtualSandbox({ fs: new InMemoryFs() }),
);
