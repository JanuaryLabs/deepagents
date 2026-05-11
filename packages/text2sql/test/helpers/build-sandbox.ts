import { InMemoryFs } from 'just-bash';

import {
  type AgentSandbox,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';

/**
 * Build a virtual-backed `AgentSandbox`. Centralized so tests + evals share
 * one shape.
 *
 * `destination: '/'` is the whole in-memory filesystem — cheap because the
 * InMemoryFs has at most a handful of files per test. Do not copy this
 * wiring for real filesystems; pick a workspace subdir there.
 */
export async function buildSandbox(): Promise<AgentSandbox> {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
    destination: '/',
  });
}
