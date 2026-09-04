import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

export default defineSandbox(() =>
  createVirtualSandbox({ fs: new InMemoryFs() }),
);
