import { InMemoryFs } from 'just-bash';

import { createVirtualSandbox } from '@deepagents/context';
import { defineSandbox } from '@deepagents/experimental/zukhruf';

/**
 * zukhruf requires a sandbox even though this agent does its real work through
 * the `save_svg` tool. An in-memory virtual sandbox satisfies that requirement
 * with no external process. `createBashTool` cd's into `/workspace`, so the
 * backend must create it before the bash tool is built.
 */
export default defineSandbox(async () => {
  const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
  await backend.executeCommand('mkdir -p /workspace');
  return backend;
});
