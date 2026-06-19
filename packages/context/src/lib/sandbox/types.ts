import type { Tool } from 'ai';
import type {
  BashToolkit,
  CommandResult,
  Sandbox as UpstreamSandbox,
} from 'bash-tool';

import type { SkillPathMapping } from '../skills/types.ts';

/**
 * Options accepted by `DisposableSandbox.executeCommand`. Currently only
 * `signal` (cooperative cancellation); shaped as an object so we can add
 * more without breaking backends.
 */
export interface ExecuteCommandOptions {
  signal?: AbortSignal;
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
 * Sandbox contract used throughout this package: upstream's three-method
 * shape plus a lifecycle hook, with `executeCommand` widened to accept
 * optional cancellation. Every backend (virtual, docker, agent-os)
 * implements this so callers can dispose uniformly. Backends that honor
 * `options.signal` forward it to their runner; others ignore. Pure
 * backends with no external resources (e.g. virtual-sandbox) supply a
 * no-op `dispose()`.
 *
 * `spawn` is optional: only backends that can honestly expose unbuffered
 * stdio (e.g. docker-sandbox) implement it. Callers feature-detect with
 * `if (!sandbox.spawn) ...` — no silent fallback that aggregates output
 * and flushes on completion.
 */
export interface DisposableSandbox
  extends Omit<UpstreamSandbox, 'executeCommand'>, AsyncDisposable {
  executeCommand(
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult>;
  spawn?(command: string, options?: SpawnOptions): SandboxProcess;
  /**
   * Release the backend's external resources. Called explicitly, or
   * automatically at scope exit via `await using` — every backend also
   * implements `[Symbol.asyncDispose]`, which delegates here.
   */
  dispose(): Promise<void>;
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
 * Input schema exposed by the wrapped bash tool — adds a required `reasoning`
 * field on top of the upstream `{ command }` shape.
 */
export interface BashToolInput {
  command: string;
  reasoning: string;
}

/** The shared wrapper's bash tool type (widened from upstream). */
export type WrappedBashTool = Tool<BashToolInput, CommandResult>;

/**
 * A sandbox that owns its skills. The factory uploads files + parses
 * frontmatter once; `skills` is then the single source of truth for
 * the `skills()` fragment. The `bash` tool is widened to require a
 * `reasoning` input on every call.
 */
export interface AgentSandbox extends Omit<
  BashToolkit,
  'bash' | 'tools' | 'sandbox'
> {
  /** Discovered skills — empty array if none were configured. */
  skills: SkillPathMapping[];
  bash: WrappedBashTool;
  tools: Omit<BashToolkit['tools'], 'bash'> & { bash: WrappedBashTool };
  sandbox: DisposableSandbox;
}
