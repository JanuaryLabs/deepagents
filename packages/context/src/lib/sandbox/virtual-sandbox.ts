import { createJustBashSandboxSessionFromNativeSandbox } from '@ai-sdk/sandbox-just-bash';
import {
  type CustomCommand,
  type IFileSystem,
  InMemoryFs,
  Sandbox,
  type SandboxOptions,
} from 'just-bash';

import { chatSandboxHandle } from './session.ts';
import {
  type ChatSandbox,
  type DisposableSandbox,
  type SandboxContext,
  type SandboxEnvironment,
  SandboxNotFoundError,
  type SandboxReadinessOptions,
} from './types.ts';

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
    // Its parameter is the other copy's class, whose private members make the two
    // nominally different, so no narrowing can reach it. Goes with #4043.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- two copies of one class
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

export type VirtualSandboxEnvironmentOptions = Omit<
  CreateVirtualSandboxOptions,
  'fs'
>;

/**
 * Chat sandboxes of just-bash in this process, each over its own in-memory
 * filesystem, which the environment keeps until `delete`. Another process or
 * another environment does not reach them. Nothing runs between commands, so
 * it has no `stop`. Each handle runs its own interpreter over the chat's
 * filesystem; `close` ends that interpreter and keeps the files. A handle
 * whose chat was deleted rejects every operation with
 * {@link SandboxNotFoundError}, and a closed handle rejects every operation:
 * just-bash itself keeps serving a stopped interpreter, and a deleted chat's
 * filesystem lives on in the handles that hold it.
 */
export class VirtualSandboxEnvironment implements SandboxEnvironment {
  readonly #options: VirtualSandboxEnvironmentOptions;
  readonly #filesystems = new Map<string, IFileSystem>();

  constructor(options: VirtualSandboxEnvironmentOptions = {}) {
    this.#options = options;
  }

  async open(chat: SandboxContext): Promise<ChatSandbox> {
    let fs = this.#filesystems.get(chat.chatId);
    if (fs === undefined) {
      fs = new InMemoryFs();
      this.#filesystems.set(chat.chatId, fs);
    }
    const sandbox = await createVirtualSandbox({ ...this.#options, fs });
    const assertCurrent = () => {
      if (this.#filesystems.get(chat.chatId) !== fs) {
        throw new SandboxNotFoundError(chat.chatId);
      }
    };
    return chatSandboxHandle(chat.chatId, sandbox, {
      resume: async () => assertCurrent(),
      release: () => sandbox.dispose(),
      assertCurrent,
    });
  }

  async delete(chat: SandboxContext): Promise<void> {
    this.#filesystems.delete(chat.chatId);
  }
}
