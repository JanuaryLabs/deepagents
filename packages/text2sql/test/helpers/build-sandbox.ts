import { InMemoryFs } from 'just-bash';

import {
  type AgentSandbox,
  type FileEvent,
  ObservedFs,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

/**
 * Build a virtual-backed `AgentSandbox` with `drainFileEvents` attached,
 * using the full composition (ObservedFs + createVirtualSandbox +
 * createBashTool). Centralized so tests + evals share one shape.
 *
 * Always attaches `drainFileEvents`; callers can assume it is present.
 */
export async function buildSandbox(): Promise<
  AgentSandbox & { drainFileEvents: () => FileEvent[] }
> {
  const observed = new ObservedFs(new InMemoryFs());
  const base = await createBashTool({
    sandbox: await createVirtualSandbox({ fs: observed }),
  });
  return { ...base, drainFileEvents: () => observed.drain() };
}
