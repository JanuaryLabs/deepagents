import type {
  Experimental_SandboxRunOptions,
  ToolResultOutput,
} from '@ai-sdk/provider-utils';
import type { Experimental_SandboxSession, Tool } from 'ai';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Host-only data omitted from model-facing tool output. */
  meta?: Record<string, unknown>;
  teeFiles?: Array<{
    command: string;
    stdoutFile: string;
  }>;
}

/**
 * The AI SDK sandbox session plus the lifecycle the session contract leaves to
 * its owner. `run` may return {@link CommandResult}'s host-only fields; a value
 * of this type is still a valid `Experimental_SandboxSession`.
 */
export interface DisposableSandbox
  extends Omit<Experimental_SandboxSession, 'run'>, AsyncDisposable {
  readonly run: (
    options: Experimental_SandboxRunOptions,
  ) => PromiseLike<CommandResult>;
  /**
   * Release what this sandbox created, and leave what it attached to (a
   * container, VM or remote sandbox it found by name or id). Called
   * explicitly, or automatically at scope exit via `await using`.
   */
  dispose(): Promise<void>;
}

/**
 * Readiness option accepted by every sandbox factory. Readiness is workload
 * policy supplied by the caller — the hook runs once after boot and gates the
 * factory's return; on failure the sandbox is disposed and the error
 * propagates, so callers either receive a sandbox that satisfies their
 * readiness condition or no sandbox at all. Recurring health monitoring stays
 * the caller's responsibility.
 *
 * @example
 * ```typescript
 * const sandbox = await createMicrosandboxSandbox({
 *   name: 'demo',
 *   readiness: (sandbox) => startDaemon(sandbox),
 * });
 * ```
 */
export interface SandboxReadinessOptions {
  readiness?: (sandbox: DisposableSandbox) => void | Promise<void>;
}

/**
 * Input schema exposed by the bash tool. `reasoning` is required for an
 * auditable explanation of every model-initiated command.
 */
export interface BashToolInput {
  command: string;
  reasoning: string;
}

export type BashToolResult = CommandResult;

export interface ReadFileToolInput {
  path: string;
  /** 1-based line number to start at for text files. */
  offset?: number;
  /** Number of text lines to return from `offset`. */
  limit?: number;
}

export interface WriteFileToolInput {
  path: string;
  content: string;
}

export type WriteFileToolResult = { success: true } | CommandResult;

export interface BeforeBashCallInput {
  command: string;
}

export interface BeforeBashCallOutput {
  command: string;
}

export interface AfterBashCallInput {
  command: string;
  result: CommandResult;
}

export interface AfterBashCallOutput {
  result?: CommandResult;
  meta?: Record<string, unknown>;
}

export interface CreateBashToolOptions {
  sandbox: DisposableSandbox;
  /**
   * Absolute directory every command starts in, created when the tool is created.
   * When omitted, commands run in the sandbox's default working directory and
   * relative paths resolve against it.
   */
  workingDirectory?: string;
  files?: Record<string, string>;
  uploadDirectory?: {
    source: string;
    include?: string;
  };
  extraInstructions?: string;
  onBeforeBashCall?: (
    input: BeforeBashCallInput,
  ) => BeforeBashCallOutput | undefined;
  onAfterBashCall?: (
    input: AfterBashCallInput,
  ) => AfterBashCallOutput | undefined;
  maxOutputLength?: number;
  maxFiles?: number;
  experimentalTeeTransform?: boolean;
}

export type WrappedBashTool = Tool<BashToolInput, BashToolResult>;
export type ReadFileTool = Tool<ReadFileToolInput, ToolResultOutput>;
export type WriteFileTool = Tool<WriteFileToolInput, WriteFileToolResult>;

/**
 * The tools a sandbox shows the model: always `bash`, plus `readFile` and
 * `writeFile` when the host exposes them.
 */
export type SandboxTools = { bash: WrappedBashTool };

/** The tools `createBashTool` builds: bash and both file tools. */
export type BashToolkitTools = SandboxTools & {
  readFile: ReadFileTool;
  writeFile: WriteFileTool;
};

/**
 * A sandbox and the tools an agent shows the model for it. The agent gives the
 * model `tools` and the AI SDK `sandbox`; it calls no tool by name, so a host
 * that shows the model only bash passes `{ tools: { bash }, sandbox }`.
 */
export interface AgentSandbox<TOOLS extends SandboxTools = SandboxTools> {
  tools: TOOLS;
  sandbox: DisposableSandbox;
}

/** What `createBashTool` returns: every tool it builds, and its sandbox. */
export interface BashToolkit extends AgentSandbox<BashToolkitTools> {
  bash: WrappedBashTool;
}
