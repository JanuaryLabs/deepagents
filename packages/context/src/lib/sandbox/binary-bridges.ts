import { existsSync } from 'fs';
import { type CustomCommand, defineCommand } from 'just-bash';
import spawn, { SubprocessError } from 'nano-spawn';
import * as path from 'path';

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
        const mergedEnv: Partial<Record<string, string>> = {
          ...process.env,
          ...Object.fromEntries(ctx.env), // ctx.env is a Map, convert to object
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
        if (error instanceof SubprocessError) {
          // nano-spawn wraps ENOENT (missing binary) into a SubprocessError
          // with exitCode undefined and the real cause on error.cause.
          if (hasErrorCode(error.cause, 'ENOENT')) {
            return {
              stdout: '',
              stderr: `${name}: ${binaryPath} not found`,
              exitCode: 127,
            };
          }

          // nano-spawn sets `exitCode` for non-zero exits and failed spawns,
          // and leaves it out when a signal killed the process.
          if ('exitCode' in error) {
            return {
              stdout: error.stdout,
              stderr: error.stderr,
              exitCode: error.exitCode ?? 1,
            };
          }
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

function hasErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === code
  );
}

/**
 * Resolves the real filesystem path from a just-bash virtual path.
 *
 * just-bash filesystems (ReadWriteFs, OverlayFs) use virtual paths like /home/user
 * but we need the actual host filesystem path for spawning processes.
 */
function resolveRealCwd(ctx: { cwd: string; fs: unknown }): string {
  const realCwd = mapToRealPath(ctx.fs, ctx.cwd) ?? process.cwd();
  // Verify the path exists, fall back to process.cwd() if not
  return existsSync(realCwd) ? realCwd : process.cwd();
}

/**
 * The host path behind `cwd`, read from the filesystem's runtime shape: the
 * `root` and `toRealPath` members it relies on are private in just-bash's
 * typings. Returns null for InMemoryFs or unknown filesystems.
 */
function mapToRealPath(fs: unknown, cwd: string): string | null {
  if (typeof fs !== 'object' || fs === null) {
    return null;
  }
  if ('root' in fs && typeof fs.root === 'string' && fs.root) {
    // ReadWriteFs - virtual paths are relative to root
    // e.g., root=/Users/x/project, cwd=/ -> /Users/x/project
    return path.join(fs.root, cwd);
  }
  if (
    'getMountPoint' in fs &&
    typeof fs.getMountPoint === 'function' &&
    'toRealPath' in fs &&
    typeof fs.toRealPath === 'function'
  ) {
    // OverlayFs - use toRealPath for proper path mapping
    const real: unknown = fs.toRealPath(cwd);
    return typeof real === 'string' ? real : null;
  }
  return null;
}
