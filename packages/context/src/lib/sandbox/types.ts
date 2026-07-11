import type { Tool } from 'ai';

import type { SkillPathMapping } from '../skills/types.ts';

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
 * Options accepted by `DisposableSandbox.executeCommand`. Currently only
 * `signal` (cooperative cancellation); shaped as an object so we can add
 * more without breaking backends.
 */
export interface ExecuteCommandOptions {
  signal?: AbortSignal;
}

export interface Sandbox {
  executeCommand(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFiles(
    files: Array<{ path: string; content: string | Buffer }>,
  ): Promise<void>;
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
 * Sandbox contract used throughout this package: buffered command execution,
 * file IO, and a lifecycle hook. Every backend (virtual, docker, agent-os)
 * implements this so callers can dispose uniformly. Backends that honor
 * `options.signal` forward it to their runner; others ignore. Pure
 * backends with no external resources (e.g. virtual-sandbox) supply a
 * no-op `dispose()`.
 *
 * `spawn` is optional: only backends that can honestly expose unbuffered
 * stdio (e.g. Docker or Apple Container sandboxes) implement it. Callers
 * feature-detect with `if (!sandbox.spawn) ...` — no silent fallback that
 * aggregates output and flushes on completion.
 */
export interface DisposableSandbox extends Sandbox, AsyncDisposable {
  spawn?(command: string, options?: SpawnOptions): SandboxProcess;
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
export interface SandboxReadinessOptions {
  readiness?: (sandbox: DisposableSandbox) => void | Promise<void>;
}

/**
 * Declarative skill upload: a host directory whose contents are copied into
 * the sandbox at startup. The factory also parses each skill's frontmatter
 * and exposes the result on `sandbox.skills`.
 */
export interface SkillUploadInput {
  /** Host directory containing skill subdirectories (each with a SKILL.md). */
  host: string;
  /** Destination inside the sandbox (e.g. `/workspace/skills`). */
  sandbox: string;
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
}

export interface ReadFileToolResult {
  content: string;
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
  destination?: string;
  files?: Record<string, string>;
  uploadDirectory?: {
    source: string;
    include?: string;
  };
  extraInstructions?: string;
  promptOptions?: {
    toolPrompt?: string;
  };
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
export type ReadFileTool = Tool<ReadFileToolInput, ReadFileToolResult>;
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

/**
 * A sandbox that owns its skills. The factory uploads files + parses
 * frontmatter once; `skills` is then the single source of truth for
 * the `skills()` fragment. The `bash` tool requires a `reasoning` input on
 * every call.
 */
export interface AgentSandbox extends BashToolkit {
  /** Discovered skills — empty array if none were configured. */
  skills: SkillPathMapping[];
}
