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
   * Release the backend's external resources. Called explicitly, or
   * automatically at scope exit via `await using`.
   */
  dispose(): Promise<void>;
}

export interface ExecuteCommandOptions {
  signal?: AbortSignal;
}

export type ReadFileEncoding = 'utf-8' | 'binary';

export interface ReadFileOptions<Encoding extends ReadFileEncoding = 'utf-8'> {
  /** `'utf-8'` (default) decodes text; `'binary'` returns the raw bytes. */
  encoding?: Encoding;
}

export type ReadFileContent<Encoding extends ReadFileEncoding> =
  Encoding extends 'binary' ? Uint8Array : string;

export interface Sandbox {
  /**
   * Execute `command` with Bash semantics. Process-backed implementations must
   * invoke `bash -lc` directly and fail clearly when Bash is unavailable.
   */
  executeCommand(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult>;
  /**
   * Read the file at `path` as UTF-8 text, or as raw bytes with
   * `{ encoding: 'binary' }`. Rejects when nothing readable is at `path`.
   */
  readFile<Encoding extends ReadFileEncoding = 'utf-8'>(
    path: string,
    options?: ReadFileOptions<Encoding>,
  ): Promise<ReadFileContent<Encoding>>;
  writeFiles(
    files: Array<{ path: string; content: string | Buffer }>,
  ): Promise<void>;
  /** Whether a file or directory exists at `path`; resolves `false` (never rejects) when missing. */
  exists(path: string): Promise<boolean>;
}

export interface SpawnOptions {
  signal?: AbortSignal;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Convenience for `code === 0`. */
  success: boolean;
}

export interface SandboxProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<ExitInfo>;
}

/**
 * The contract of backends not yet ported to {@link DisposableSandbox}.
 * `createBashTool` adapts them through `fromLegacySandbox`. Deleted with the
 * last port.
 */
export interface LegacySandbox extends Sandbox, AsyncDisposable {
  /** Spawn `command` with the same Bash contract as {@link Sandbox.executeCommand}. */
  spawn?(command: string, options?: SpawnOptions): Promise<SandboxProcess>;
  /**
   * Release the backend's external resources. Called explicitly, or
   * automatically at scope exit via `await using` — every backend also
   * implements `[Symbol.asyncDispose]`, which delegates here.
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
export interface SandboxReadinessOptions<TSandbox = DisposableSandbox> {
  readiness?: (sandbox: TSandbox) => void | Promise<void>;
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
  sandbox: DisposableSandbox | LegacySandbox;
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

export interface BashToolkit {
  bash: WrappedBashTool;
  tools: {
    bash: WrappedBashTool;
    readFile: ReadFileTool;
    writeFile: WriteFileTool;
  };
  sandbox: DisposableSandbox;
}

/** Bash/read/write tools and their underlying sandbox for use by an agent. */
export type AgentSandbox = BashToolkit;
