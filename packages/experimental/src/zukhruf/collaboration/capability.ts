import type { ToolSet } from 'ai';

/** Whose collaboration guidance: the root agent's or a sub-agent's. */
export type Role = 'root' | 'subagent';

/** The name guidance uses for a collaboration tool on the team's exposure. */
export type ToolNamer = (toolName: string) => string;

/** The sentences one capability adds to a role's collaboration guidance. */
export interface Guidance {
  /** Sentences that open the description of what the team can do. */
  readonly intro?: string;
  /** Clauses of the team's "Use …" sentence, one per tool it explains. */
  readonly uses?: readonly string[];
  /** Sentences that follow the "Use …" sentence. */
  readonly notes?: string;
  /** A paragraph after the sentences every team shares. */
  readonly outro?: string;
}

/** One part of a team's collaboration: its tools and its own guidance. */
export interface Capability {
  readonly tools: ToolSet;
  guidance(role: Role, name: ToolNamer): Guidance;
}
