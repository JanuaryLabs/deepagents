import {
  Bash,
  type BashOptions,
  type CustomCommand,
  type IFileSystem,
} from 'just-bash';

import { readFileContent } from './read-file.ts';
import type { DisposableSandbox, SandboxReadinessOptions } from './types.ts';

export interface CreateVirtualSandboxOptions extends SandboxReadinessOptions {
  fs: IFileSystem;
  cwd?: string;
  env?: Record<string, string>;
  javascript?: BashOptions['javascript'];
  customCommands?: CustomCommand[];
}

export async function createVirtualSandbox(
  options: CreateVirtualSandboxOptions,
): Promise<DisposableSandbox> {
  const { fs } = options;
  const bash = new Bash({
    fs,
    cwd: options.cwd,
    env: options.env,
    javascript: options.javascript,
    customCommands: options.customCommands,
  });
  // Same path resolution as `bash.readFile`/`bash.writeFile`, but straight to
  // the filesystem so binary content never round-trips through a string.
  const resolve = (path: string) => fs.resolvePath(bash.getCwd(), path);

  const sandbox: DisposableSandbox = {
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

    async readFile(path, readOptions) {
      return readFileContent(
        await fs.readFileBuffer(resolve(path)),
        readOptions,
      );
    },

    async writeFiles(files) {
      for (const file of files) {
        await fs.writeFile(resolve(file.path), file.content);
      }
    },

    async exists(path) {
      return fs.exists(resolve(path));
    },

    async dispose() {},

    [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
      return this.dispose();
    },
  };

  if (options.readiness) {
    try {
      await options.readiness(sandbox);
    } catch (error) {
      await sandbox.dispose().catch(() => {});
      throw error;
    }
  }
  return sandbox;
}
