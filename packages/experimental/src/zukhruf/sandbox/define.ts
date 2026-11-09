import {
  type CreateBashToolOptions,
  createBashTool,
} from '@deepagents/context';

import type { SandboxContext, ZukhrufSandbox } from '../agent.ts';

type WrapOptions = Omit<CreateBashToolOptions, 'sandbox'>;

const DEFAULT_WORKING_DIRECTORY = '/workspace';

/** Wrap a backend with Zukhruf's Bash toolkit and working-directory metadata. */
export function defineSandbox(
  createBackend: (
    context: SandboxContext,
  ) => Promise<CreateBashToolOptions['sandbox']>,
  options?: WrapOptions,
): (context: SandboxContext) => Promise<ZukhrufSandbox> {
  return async (context) => {
    const workingDirectory =
      options?.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;

    return Object.assign(
      await createBashTool({
        sandbox: await createBackend(context),
        ...options,
        workingDirectory,
      }),
      { workingDirectory },
    );
  };
}
