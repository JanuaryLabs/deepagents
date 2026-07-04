import {
  type AgentSandbox,
  type DisposableSandbox,
  createBashTool,
} from '@deepagents/context';

import type { SandboxContext } from '../agent.ts';

type WrapOptions = Omit<Parameters<typeof createBashTool>[0], 'sandbox'>;

export function defineSandbox(
  createBackend: (context: SandboxContext) => Promise<DisposableSandbox>,
  options?: WrapOptions,
): (context: SandboxContext) => Promise<AgentSandbox> {
  return async (context) =>
    createBashTool({ sandbox: await createBackend(context), ...options });
}
