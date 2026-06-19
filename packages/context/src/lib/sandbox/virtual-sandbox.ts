import { Bash, type CustomCommand, type IFileSystem } from 'just-bash';

import type { DisposableSandbox } from './types.ts';

export interface CreateVirtualSandboxOptions {
  fs: IFileSystem;
  cwd?: string;
  env?: Record<string, string>;
  customCommands?: CustomCommand[];
}

export async function createVirtualSandbox(
  options: CreateVirtualSandboxOptions,
): Promise<DisposableSandbox> {
  const bash = new Bash({
    fs: options.fs,
    cwd: options.cwd,
    env: options.env,
    customCommands: options.customCommands,
  });

  return {
    async executeCommand(command, options) {
      const result = await bash.exec(
        command,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },

    async readFile(path) {
      return bash.readFile(path);
    },

    async writeFiles(files) {
      for (const file of files) {
        await bash.writeFile(
          file.path,
          typeof file.content === 'string'
            ? file.content
            : Buffer.from(file.content).toString('utf-8'),
        );
      }
    },

    async dispose() {},

    [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
      return this.dispose();
    },
  };
}
