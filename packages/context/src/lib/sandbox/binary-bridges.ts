import { defineCommand, type CustomCommand } from 'just-bash';
import spawn from 'nano-spawn';
import * as path from 'path';
import { existsSync } from 'fs';

export interface BinaryBridgeConfig {
  /** Command name in the sandbox (what the agent types) */
  name: string;
  /** Actual binary path on the host system (defaults to name) */
  binaryPath?: string;
  /** Optional regex to restrict allowed arguments for security */
  allowedArgs?: RegExp;
}

export type BinaryBridgeInput = string | BinaryBridgeConfig;

/**
 * Creates custom commands that bridge to real system binaries.
 *
 * This allows just-bash sandboxed environments to execute specific
 * host system binaries while maintaining control over which binaries
 * are accessible.
 *
 * @example
 * // Simple - just strings (name === binaryPath)
 * createBinaryBridges('presenterm', 'node', 'cargo')
 *
 * @example
 * // Mixed - strings and config objects
 * createBinaryBridges(
 *   'presenterm',
 *   { name: 'python', binaryPath: 'python3' },
 *   { name: 'git', allowedArgs: /^(status|log|diff)/ }
 * )
 */
export function createBinaryBridges(
  ...binaries: BinaryBridgeInput[]
): CustomCommand[] {
  return binaries.map((input) => {
    const config: BinaryBridgeConfig =
      typeof input === 'string' ? { name: input } : input;

    const { name, binaryPath = name, allowedArgs } = config;

    return defineCommand(name, async (args, ctx) => {
      // Validate args against pattern if specified
      if (allowedArgs) {
        const invalidArg = args.find((arg) => !allowedArgs.test(arg));
        if (invalidArg) {
          return {
            stdout: '',
            stderr: `${name}: argument '${invalidArg}' not allowed by security policy`,
            exitCode: 1,
          };
        }
      }

      try {
        // Resolve the real working directory from the virtual filesystem
        // just-bash uses virtual paths like /home/user, we need the real host path
        const realCwd = resolveRealCwd(ctx);

        // Resolve file paths in arguments relative to the real cwd
        const resolvedArgs = args.map((arg) => {
          // Skip flags and options
          if (arg.startsWith('-')) {
            return arg;
          }

          // Check if arg looks like a path:
          // 1. Has a file extension (e.g., file.md, script.py)
          // 2. Contains path separator (e.g., src/file, dir\file)
          // 3. Is a relative path starting with . (e.g., ., .., ./foo)
          const hasExtension = path.extname(arg) !== '';
          const hasPathSep = arg.includes(path.sep) || arg.includes('/');
          const isRelative = arg.startsWith('.');

          if (hasExtension || hasPathSep || isRelative) {
            // Resolve relative to the real cwd
            return path.resolve(realCwd, arg);
          }

          return arg;
        });

        // Merge environments but preserve process.env.PATH for binary resolution
        // ctx.env.PATH is the virtual PATH (/bin:/usr/bin) which doesn't include host binaries
        const mergedEnv = {
          ...process.env,
          ...ctx.env,
          PATH: process.env.PATH, // Always use host PATH for binary bridges
        };

        const result = await spawn(binaryPath, resolvedArgs, {
          cwd: realCwd,
          env: mergedEnv,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: 0,
        };
      } catch (error) {
        // nano-spawn throws SubprocessError for non-zero exits
        if (error && typeof error === 'object' && 'exitCode' in error) {
          const subprocessError = error as {
            exitCode?: number;
            stdout: string;
            stderr: string;
          };
          return {
            stdout: subprocessError.stdout ?? '',
            stderr: subprocessError.stderr ?? '',
            exitCode: subprocessError.exitCode ?? 1,
          };
        }

        // Unknown error (e.g., binary not found)
        return {
          stdout: '',
          stderr: `${name}: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 127,
        };
      }
    });
  });
}

/**
 * Resolves the real filesystem path from a just-bash virtual path.
 *
 * just-bash filesystems (ReadWriteFs, OverlayFs) use virtual paths like /home/user
 * but we need the actual host filesystem path for spawning processes.
 */
function resolveRealCwd(ctx: {
  cwd: string;
  fs: unknown;
}): string {
  const fs = ctx.fs as {
    toRealPath?: (p: string) => string | null;
    root?: string;
    getMountPoint?: () => string;
  };

  let realCwd: string;

  if (fs.root) {
    // ReadWriteFs - virtual paths are relative to root
    // e.g., root=/Users/x/project, cwd=/ -> /Users/x/project
    realCwd = path.join(fs.root, ctx.cwd);
  } else if (typeof fs.getMountPoint === 'function' && typeof fs.toRealPath === 'function') {
    // OverlayFs - use toRealPath for proper path mapping
    const real = fs.toRealPath(ctx.cwd);
    realCwd = real ?? process.cwd();
  } else {
    // Fallback for InMemoryFs or unknown filesystems
    realCwd = process.cwd();
  }

  // Verify the path exists, fall back to process.cwd() if not
  if (!existsSync(realCwd)) {
    realCwd = process.cwd();
  }

  return realCwd;
}
