import type { Tool } from 'ai';
import type { BashToolkit, CommandResult } from 'bash-tool';

import type { SkillPathMapping } from '../skills/types.ts';
import type { FileEvent } from './file-events.ts';

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
export interface AgentSandbox extends Omit<BashToolkit, 'bash' | 'tools'> {
  /** Discovered skills — empty array if none were configured. */
  skills: SkillPathMapping[];
  bash: WrappedBashTool;
  tools: Omit<BashToolkit['tools'], 'bash'> & { bash: WrappedBashTool };
  /**
   * Drain and return file events observed since the last call. Attached by
   * callers who composed an `ObservedFs` into their backend; omitted
   * otherwise. The chat pipeline reads this via optional chaining.
   */
  drainFileEvents?(): FileEvent[];
}
