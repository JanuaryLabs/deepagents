import { type CommandResult, type Sandbox } from 'bash-tool';

const textDecoder = new TextDecoder();

/**
 * Local shape of the AgentOs instance we depend on.
 * Defined locally to avoid importing from optional peer dep at the type level.
 */
interface AgentOsInstance {
  exec(
    command: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
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

export interface AgentOsSandbox extends Sandbox {
  dispose(): Promise<void>;
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

/**
 * Creates a WASM-based sandbox backed by Agent OS.
 *
 * Agent OS runs commands in an in-process WASM virtual machine — no Docker required.
 * Near-zero cold start (~6ms) with real WASM-compiled binaries (coreutils, grep, etc.).
 *
 * @experimental Agent OS is v0.1.0 preview. API may change.
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
): Promise<AgentOsSandbox> {
  const { AgentOs } = await importAgentOs();

  let os: AgentOsInstance;
  try {
    os = await AgentOs.create(options as Record<string, unknown>);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw new AgentOsCreationError(err.message, err);
  }

  return {
    async executeCommand(command: string): Promise<CommandResult> {
      try {
        const result = await os.exec(command);
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (error) {
        const err = error as Error & {
          stdout?: string;
          stderr?: string;
          exitCode?: number;
        };
        return {
          stdout: err.stdout || '',
          stderr: err.stderr || err.message || '',
          exitCode: err.exitCode ?? 1,
        };
      }
    },

    async readFile(path: string): Promise<string> {
      try {
        const bytes = await os.readFile(path);
        return textDecoder.decode(bytes);
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
  fn: (sandbox: AgentOsSandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await createAgentOsSandbox(options);
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.dispose();
  }
}
