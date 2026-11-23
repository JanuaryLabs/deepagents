import {
  type CreateBashToolOptions,
  type StoppableSandboxEnvironment,
  createBashTool,
} from '@deepagents/context';

import type {
  SessionSandboxDeclaration,
  StoppableSandboxDeclaration,
  ZukhrufSandboxDeclaration,
} from '../agent.ts';

type WrapOptions = Omit<CreateBashToolOptions, 'sandbox'>;

type SessionSandboxEnvironment = SessionSandboxDeclaration['environment'];

const DEFAULT_WORKING_DIRECTORY = '/workspace';

/**
 * An agent's sandboxes in `environment`, each wrapped in Zukhruf's Bash
 * toolkit with its working-directory metadata. The environment is a value,
 * not a function, so the runtime stops and deletes a chat's sandbox in the
 * same environment that opened it. An environment that can stop its
 * sandboxes requires `idleTimeoutMs`, a non-negative safe integer or `false`;
 * any other environment takes none.
 */
export function defineSandbox(
  environment: StoppableSandboxEnvironment,
  options: WrapOptions & { readonly idleTimeoutMs: number | false },
): StoppableSandboxDeclaration;
export function defineSandbox(
  environment: SessionSandboxEnvironment,
  options?: WrapOptions & { readonly idleTimeoutMs?: never },
): SessionSandboxDeclaration;
export function defineSandbox(
  environment: StoppableSandboxEnvironment | SessionSandboxEnvironment,
  options?: WrapOptions & { readonly idleTimeoutMs?: number | false },
): ZukhrufSandboxDeclaration {
  const { idleTimeoutMs, ...wrapOptions } = options ?? {};
  const workingDirectory =
    wrapOptions.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
  const open: ZukhrufSandboxDeclaration['open'] = async (chat) => {
    const sandbox = await environment.open(chat);
    try {
      return Object.assign(
        await createBashTool({ sandbox, ...wrapOptions, workingDirectory }),
        { workingDirectory },
      );
    } catch (error) {
      await sandbox.close();
      throw error;
    }
  };
  if (environment.stop === undefined) return { environment, open };
  if (
    idleTimeoutMs === false ||
    (typeof idleTimeoutMs === 'number' &&
      Number.isSafeInteger(idleTimeoutMs) &&
      idleTimeoutMs >= 0)
  ) {
    return { environment, idleTimeoutMs, open };
  }
  throw new RangeError(
    'idleTimeoutMs must be a non-negative safe integer or false.',
  );
}
