import { createJustBashSandboxSessionFromNativeSandbox } from '@ai-sdk/sandbox-just-bash';
import {
  type CustomCommand,
  type IFileSystem,
  Sandbox,
  type SandboxOptions,
} from 'just-bash';

import type { DisposableSandbox, SandboxReadinessOptions } from './types.ts';

export interface CreateVirtualSandboxOptions extends SandboxReadinessOptions {
  fs: IFileSystem;
  cwd?: string;
  env?: Record<string, string>;
  javascript?: SandboxOptions['javascript'];
  customCommands?: CustomCommand[];
}

export async function createVirtualSandbox({
  readiness,
  ...options
}: CreateVirtualSandboxOptions): Promise<DisposableSandbox> {
  const native = await Sandbox.create(options);
  const dispose = () => native.stop();
  const sandbox: DisposableSandbox = Object.assign(
    // The adapter pins just-bash ^2 and we run ^3 for customCommands on Sandbox.
    // Its parameter is the other copy's class, whose private members make the two nominally different.
    createJustBashSandboxSessionFromNativeSandbox(native as never),
    { dispose, [Symbol.asyncDispose]: dispose },
  );

  if (readiness) {
    try {
      await readiness(sandbox);
    } catch (error) {
      await sandbox.dispose().catch(() => {});
      throw error;
    }
  }
  return sandbox;
}
