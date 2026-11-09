import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

/**
 * zukhruf requires a sandbox even though this agent does its real work through
 * the `save_svg` tool. An in-memory virtual sandbox satisfies that requirement
 * with no external process.
 */
export default defineSandbox(() =>
  createVirtualSandbox({ fs: new InMemoryFs() }),
);
