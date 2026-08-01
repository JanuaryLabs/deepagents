import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

/**
 * The specialist does not need the root turn's Docker workspace. A private
 * in-memory sandbox satisfies the agent contract without creating a second
 * container or leaking filesystem state between parent and child.
 */
export default defineSandbox(
  () => createVirtualSandbox({ fs: new InMemoryFs() }),
  {
    uploadDirectory: {
      source: import.meta.dirname,
      include: 'skills/**/*',
    },
  },
);
