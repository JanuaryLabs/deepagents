import { type CommandResult } from 'bash-tool';
import { PassThrough, Readable } from 'node:stream';

import type {
  DisposableSandbox,
  ExecuteCommandOptions,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

const decoder = new TextDecoder();

interface KernelExecOptions {
  env?: Record<string, string>;
  cwd?: string;
}

interface AgentOsInstance {
  spawn(
    command: string,
    args: string[],
    options?: KernelExecOptions,
  ): { pid: number };
  onProcessStdout(pid: number, handler: (data: Uint8Array) => void): () => void;
  onProcessStderr(pid: number, handler: (data: Uint8Array) => void): () => void;
  waitProcess(pid: number): Promise<number>;
  killProcess(pid: number): void;
  readFile(path: string): Promise<Uint8Array>;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array }>,
  ): Promise<Array<{ path: string; success: boolean; error?: string }>>;
  dispose(): Promise<void>;
}

interface AgentOsStatic {
  create(options?: Record<string, unknown>): Promise<AgentOsInstance>;
}

export class AgentOsSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentOsSandboxError';
  }
}

export class AgentOsNotAvailableError extends AgentOsSandboxError {
  constructor(cause?: Error) {
    super(
      '@rivet-dev/agent-os-core is not installed. Install it with: npm install @rivet-dev/agent-os-core @rivet-dev/agent-os-common',
    );
    this.name = 'AgentOsNotAvailableError';
    this.cause = cause;
  }
}

export class AgentOsCreationError extends AgentOsSandboxError {
  constructor(message: string, cause?: Error) {
    super(`Failed to create Agent OS instance: ${message}`);
    this.name = 'AgentOsCreationError';
    this.cause = cause;
  }
}

export interface AgentOsSandboxOptions {
  /** WASM software packages (e.g., @rivet-dev/agent-os-common) */
  software?: unknown[];
  /** Filesystem mounts inside the VM */
  mounts?: Array<{ path: string; driver: unknown; readOnly?: boolean }>;
  /** Host tool kits to expose inside the VM */
  toolKits?: unknown[];
  /** Kernel permissions (defaults to allowAll) */
  permissions?: unknown;
  /**
   * Host-side CWD for module resolution.
   * Projects this directory's node_modules into the VM at /root/node_modules/.
   */
  moduleAccessCwd?: string;
}

async function importAgentOs(): Promise<{ AgentOs: AgentOsStatic }> {
  try {
    return await import('@rivet-dev/agent-os-core');
  } catch (error) {
    throw new AgentOsNotAvailableError(
      error instanceof Error ? error : undefined,
    );
  }
}

const SIGKILL_EXIT_CODE = 9;

interface KernelProcess {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  exit: Promise<number>;
  kill(): void;
  /**
   * True iff the process was both signalled via `kill()` AND the kernel
   * reported the SIGKILL exit code. Guards against a race where `kill()`
   * is called after the process had already exited naturally — in that
   * case the natural exit code stands and this returns false.
   */
  wasKilled(exitCode: number): boolean;
}

function startKernelProcess(
  os: AgentOsInstance,
  command: string,
  options: KernelExecOptions,
): KernelProcess {
  const { pid } = os.spawn('sh', ['-c', command], options);

  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const unsubOut = os.onProcessStdout(pid, (chunk) => stdout.write(chunk));
  const unsubErr = os.onProcessStderr(pid, (chunk) => stderr.write(chunk));

  let killSignalled = false;
  const exit = os.waitProcess(pid).finally(() => {
    unsubOut();
    unsubErr();
    stdout.end();
    stderr.end();
  });

  return {
    pid,
    stdout,
    stderr,
    exit,
    kill: () => {
      if (killSignalled) return;
      killSignalled = true;
      os.killProcess(pid);
    },
    wasKilled: (exitCode) => killSignalled && exitCode === SIGKILL_EXIT_CODE,
  };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Wire an AbortSignal to a cancellation callback. Returns an unbind fn that
 * removes the listener. If the signal is already aborted, fires `onAbort`
 * synchronously and returns a no-op unbind.
 */
function bindAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Creates a WASM-based sandbox backed by Agent OS.
 *
 * Agent OS runs commands in an in-process WASM virtual machine — no Docker required.
 * Near-zero cold start (~6ms) with real WASM-compiled binaries (coreutils, grep, etc.).
 *
 * Internally, `executeCommand` lowers to `spawn('sh', ['-c', cmd])` so a single
 * code path supports `AbortSignal` (the kernel's `exec(command)` does not return
 * a pid and so cannot be cancelled).
 *
 * @experimental Agent OS is v0.1.1 preview. API may change.
 *
 * Requires optional peer dependencies:
 * - `@rivet-dev/agent-os-core`
 * - `@rivet-dev/agent-os-common` (or individual WASM command packages)
 *
 * @example Basic usage
 * ```typescript
 * import common from '@rivet-dev/agent-os-common';
 *
 * const sandbox = await createAgentOsSandbox({ software: [common] });
 * const result = await sandbox.executeCommand('echo hello');
 * console.log(result.stdout); // "hello"
 * await sandbox.dispose();
 * ```
 *
 * @example With createBashTool (AI SDK integration)
 * ```typescript
 * import { createBashTool } from 'bash-tool';
 * import common from '@rivet-dev/agent-os-common';
 *
 * const sandbox = await createAgentOsSandbox({ software: [common] });
 * const { tools } = await createBashTool({ sandbox });
 * // Pass tools to generateText() / streamText()
 * await sandbox.dispose();
 * ```
 */
export async function createAgentOsSandbox(
  options: AgentOsSandboxOptions = {},
): Promise<DisposableSandbox> {
  const { AgentOs } = await importAgentOs();

  let os: AgentOsInstance;
  try {
    os = await AgentOs.create(options as Record<string, unknown>);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AgentOsCreationError(err.message, err);
  }

  return {
    async executeCommand(
      command: string,
      { signal }: ExecuteCommandOptions = {},
    ): Promise<CommandResult> {
      if (signal?.aborted) {
        return { stdout: '', stderr: '', exitCode: SIGKILL_EXIT_CODE };
      }

      const proc = startKernelProcess(os, command, {});
      const unbind = bindAbort(signal, proc.kill);

      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readAll(proc.stdout),
          readAll(proc.stderr),
          proc.exit,
        ]);
        return { stdout, stderr, exitCode };
      } finally {
        unbind();
      }
    },

    spawn(
      command: string,
      { signal, env, cwd }: SpawnOptions = {},
    ): SandboxProcess {
      if (signal?.aborted) {
        const empty = (): ReadableStream<Uint8Array> =>
          new ReadableStream({ start: (c) => c.close() });
        return {
          stdout: empty(),
          stderr: empty(),
          exit: Promise.resolve({
            code: null,
            signal: 'SIGKILL' as NodeJS.Signals,
            success: false,
          }),
        };
      }

      const proc = startKernelProcess(os, command, { env, cwd });
      const unbind = bindAbort(signal, proc.kill);

      const exit = proc.exit
        .then((code) => {
          const killed = proc.wasKilled(code);
          return {
            code: killed ? null : code,
            signal: killed ? ('SIGKILL' as NodeJS.Signals) : null,
            success: !killed && code === 0,
          };
        })
        .finally(unbind);

      return {
        stdout: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>,
        exit,
      };
    },

    async readFile(path: string): Promise<string> {
      try {
        const bytes = await os.readFile(path);
        return decoder.decode(bytes);
      } catch (error) {
        throw new Error(
          `Failed to read file "${path}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },

    async writeFiles(
      files: Array<{ path: string; content: string | Buffer }>,
    ): Promise<void> {
      const results = await os.writeFiles(
        files.map((f) => ({
          path: f.path,
          content:
            typeof f.content === 'string'
              ? f.content
              : new Uint8Array(f.content),
        })),
      );

      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        const details = failures.map((f) => `${f.path}: ${f.error}`).join(', ');
        throw new Error(`Failed to write files: ${details}`);
      }
    },

    async dispose(): Promise<void> {
      try {
        await os.dispose();
      } catch {
        // Ignore disposal errors (VM may already be disposed)
      }
    },

    [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
      return this.dispose();
    },
  };
}

/**
 * Run a function with an Agent OS sandbox that auto-disposes on completion.
 *
 * @example
 * ```typescript
 * import common from '@rivet-dev/agent-os-common';
 *
 * const output = await useAgentOsSandbox(
 *   { software: [common] },
 *   async (sandbox) => {
 *     const result = await sandbox.executeCommand('echo hello');
 *     return result.stdout;
 *   },
 * );
 * ```
 */
export async function useAgentOsSandbox<T>(
  options: AgentOsSandboxOptions,
  fn: (sandbox: DisposableSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createAgentOsSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
