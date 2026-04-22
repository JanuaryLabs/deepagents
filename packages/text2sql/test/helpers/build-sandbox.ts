import { InMemoryFs } from 'just-bash';

import {
  type AgentSandbox,
  type FileEvent,
  ObservedFs,
  type SandboxExtension,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
} from '@deepagents/context';

/**
 * Build a virtual-backed `AgentSandbox` with `drainFileEvents` attached,
 * using the full composition (ObservedFs + createVirtualSandbox +
 * createRoutingSandbox + createBashTool). Centralized so tests + evals
 * share one shape.
 *
 * Always attaches `drainFileEvents`; callers can assume it is present.
 */
export async function buildSandbox(
  extensions: SandboxExtension[] = [],
): Promise<AgentSandbox & { drainFileEvents: () => FileEvent[] }> {
  const observed = new ObservedFs(new InMemoryFs());
  const base = await createBashTool({
    sandbox: await createRoutingSandbox({
      backend: await createVirtualSandbox({ fs: observed }),
      hostExtensions: extensions,
    }),
  });
  return { ...base, drainFileEvents: () => observed.drain() };
}
