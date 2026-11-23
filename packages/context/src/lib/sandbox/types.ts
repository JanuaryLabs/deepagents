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
 * What every sandbox offers its user: the AI SDK sandbox session, whose `run`
 * may also return {@link CommandResult}'s host-only fields. A value of this
 * type is a valid `Experimental_SandboxSession`. It has no lifecycle: who ends
 * a sandbox, and how, depends on how it was made.
 */
export interface SandboxSession extends Omit<
  Experimental_SandboxSession,
  'run'
> {
  readonly run: (
    options: Experimental_SandboxRunOptions,
  ) => PromiseLike<CommandResult>;
}

/** A sandbox from a `create*Sandbox` factory, which its owner disposes. */
export interface DisposableSandbox extends SandboxSession, AsyncDisposable {
  /**
   * Release what this sandbox created, and leave what it attached to (a
   * container, VM or remote sandbox it found by name or id). Called
   * explicitly, or automatically at scope exit via `await using`.
   */
  dispose(): Promise<void>;
}

/** The chat whose sandbox an environment opens, stops or deletes. */
export interface SandboxContext {
  readonly chatId: string;
  readonly userId: string;
}

/**
 * A live handle to one chat's sandbox, from {@link SandboxEnvironment.open}.
 * Other handles, in this process or another, can reach the same sandbox.
 * Once {@link SandboxEnvironment.delete} removes the chat's sandbox, every
 * operation of a handle opened before it (`run`, `spawn`, each file
 * operation and `resume`) rejects with {@link SandboxNotFoundError}, also
 * after the chat is opened again; the owner closes the handle and opens the
 * chat again.
 */
export interface ChatSandbox extends SandboxSession, AsyncDisposable {
  /**
   * Makes the sandbox this handle holds usable again: starts it when it is
   * stopped, and resolves at once when it runs. Rejects with
   * {@link SandboxNotFoundError} when the sandbox no longer exists, or when
   * another sandbox now has its name; the owner then closes this handle and
   * opens the chat again. Never creates a sandbox.
   */
  resume(): Promise<void>;
  /**
   * Releases what this process holds for the sandbox, such as the engine
   * client or the VM connection. Never stops, starts or removes the sandbox.
   * Runs once; `[Symbol.asyncDispose]` is the same call. Afterwards every
   * operation of this handle rejects, and never with
   * {@link SandboxNotFoundError}: using a closed handle is a bug in its
   * owner, not a sandbox that is gone.
   */
  close(): Promise<void>;
}

/**
 * Where the sandboxes of chats live: a backend's options and a namespace.
 * Building one does no I/O. Each chat has one sandbox, which the backend
 * names from the namespace and the chat's id; the caller never names it.
 * Options apply only when `open` creates the sandbox: an existing sandbox
 * keeps the configuration it was created with.
 */
export interface SandboxEnvironment {
  /**
   * The chat's sandbox, live: attached when it runs, started when it is
   * stopped, created when there is none. Two callers that open the same chat
   * at once get the same sandbox.
   */
  open(chat: SandboxContext): Promise<ChatSandbox>;
  /**
   * Removes the chat's sandbox and everything in it outside its volumes.
   * Never starts it, never touches a volume, and resolves when there is none.
   */
  delete(chat: SandboxContext): Promise<void>;
}

/** An environment whose sandboxes can stop and keep their files. */
export interface StoppableSandboxEnvironment extends SandboxEnvironment {
  /**
   * Stops the chat's sandbox and keeps its files, so the next `open` or
   * `resume` starts it again. Never starts it; resolves when it is already
   * stopped or there is none.
   */
  stop(chat: SandboxContext): Promise<void>;
}

/**
 * The environment behind a sandbox no longer exists (its container was
 * removed), so every operation of that sandbox rejects with this error until
 * its owner acquires a new one by name, or closes the handle and opens the
 * chat again. A failed command is not this error.
 */
export class SandboxNotFoundError extends Error {
  constructor(sandbox: string, options?: ErrorOptions) {
    super(`The sandbox "${sandbox}" no longer exists.`, options);
    this.name = 'SandboxNotFoundError';
  }
}

/**
 * Readiness option accepted by every sandbox factory and environment.
 * Readiness is workload policy supplied by the caller. The hook runs once per
 * `create` or `open`, so it must be safe to repeat, and gates its return; on
 * failure the sandbox is released and the error propagates, so callers either
 * receive a sandbox that satisfies their readiness condition or no sandbox at
 * all. Recurring health monitoring stays the caller's responsibility.
 *
 * @example
 * ```typescript
 * const sandbox = await createMicrosandboxSandbox({
 *   readiness: (sandbox) => startDaemon(sandbox),
 * });
 * ```
 */
export interface SandboxReadinessOptions {
  readiness?: (sandbox: SandboxSession) => void | Promise<void>;
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

export interface CreateBashToolOptions<
  SANDBOX extends SandboxSession = SandboxSession,
> {
  sandbox: SANDBOX;
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
export interface AgentSandbox<
  TOOLS extends SandboxTools = SandboxTools,
  SANDBOX extends SandboxSession = SandboxSession,
> {
  tools: TOOLS;
  sandbox: SANDBOX;
}

/** What `createBashTool` returns: every tool it builds, and its sandbox. */
export interface BashToolkit<
  SANDBOX extends SandboxSession = SandboxSession,
> extends AgentSandbox<BashToolkitTools, SANDBOX> {
  bash: WrappedBashTool;
}
