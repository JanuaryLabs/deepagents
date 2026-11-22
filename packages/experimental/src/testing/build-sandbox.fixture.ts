import { VirtualSandboxEnvironment, createBashTool } from '@deepagents/context';
import type { ZukhrufSandboxDeclaration } from '@deepagents/experimental/zukhruf';

/** An agent's sandboxes over a virtual environment of their own, with no working directory. */
export function buildSandbox(): ZukhrufSandboxDeclaration {
  const environment = new VirtualSandboxEnvironment();
  return {
    environment,
    open: async (chat) =>
      createBashTool({ sandbox: await environment.open(chat) }),
  };
}
