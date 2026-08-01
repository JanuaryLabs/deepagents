import { type DisposableSandbox, createBashTool } from '@deepagents/context';

import type { SandboxContext, ZukhrufSandbox } from '../agent.ts';

type WrapOptions = Omit<Parameters<typeof createBashTool>[0], 'sandbox'>;

const DEFAULT_WORKING_DIRECTORY = '/workspace';

/** Wrap a backend with Zukhruf's Bash toolkit and working-directory metadata. */
export function defineSandbox(
  createBackend: (context: SandboxContext) => Promise<DisposableSandbox>,
  options?: WrapOptions,
): (context: SandboxContext) => Promise<ZukhrufSandbox> {
  return async (context) => {
    const workingDirectory = options?.destination ?? DEFAULT_WORKING_DIRECTORY;

    return Object.assign(
      await createBashTool({
        sandbox: await createBackend(context),
        ...options,
        destination: workingDirectory,
      }),
      { workingDirectory },
    );
  };
}
