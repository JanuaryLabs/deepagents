import {
  type CreateBashToolOptions,
  type SandboxEnvironment,
  createBashTool,
} from '@deepagents/context';

import type { ZukhrufSandboxDeclaration } from '../agent.ts';

type WrapOptions = Omit<CreateBashToolOptions, 'sandbox'>;

const DEFAULT_WORKING_DIRECTORY = '/workspace';

/**
 * An agent's sandboxes in `environment`, each wrapped in Zukhruf's Bash
 * toolkit with its working-directory metadata. The environment is a value,
 * not a function, so the runtime stops and deletes a chat's sandbox in the
 * same environment that opened it.
 */
export function defineSandbox(
  environment: SandboxEnvironment,
  options?: WrapOptions,
): ZukhrufSandboxDeclaration {
  const workingDirectory =
    options?.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
  return {
    environment,
    open: async (chat) => {
      const sandbox = await environment.open(chat);
      try {
        return Object.assign(
          await createBashTool({ sandbox, ...options, workingDirectory }),
          { workingDirectory },
        );
      } catch (error) {
        await sandbox.close();
        throw error;
      }
    },
  };
}
