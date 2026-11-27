import type { Trajectory } from './atif.ts';

/**
 * The port: turns one located session of one agent into one ATIF trajectory
 * (ADR 0006). Each agent has its own `Session` type, so an adapter cannot be
 * handed another agent's session.
 */
export interface Adapter<Session> {
  /** ATIF `agent.name`: `claude-code`, `codex`, … */
  readonly agent: string;
  read(session: Session, options?: ReadOptions): Promise<ReadResult>;
}

export interface ReadOptions {
  /** Read the session's subagents into `subagent_trajectories`. Default true. */
  subagents?: boolean;
}

export interface ReadResult {
  trajectory: Trajectory;
  diagnostics: Diagnostic[];
}

export type DiagnosticCode =
  /** A line that does not parse as a JSON object. */
  | 'invalid_json_line'
  /** The last line, still being written by the agent. */
  | 'partial_last_line'
  /** Bookkeeping with no step, counted by entry type. */
  | 'unmapped_entry'
  /** An `isSidechain` row inside a main transcript. */
  | 'sidechain_entry'
  /** A tool result whose call is not in the transcript. */
  | 'orphan_tool_result'
  /** A subagent whose spawning call could not be found. */
  | 'unlinked_subagent'
  /** A subagent transcript that could not be read. */
  | 'unreadable_subagent';

export interface Diagnostic {
  code: DiagnosticCode;
  /** The file the diagnostic is about. */
  path: string;
  /** 1-based line, for a diagnostic about one line. */
  line?: number;
  /** How many entries it covers, for a counted diagnostic. */
  count?: number;
  /** The entry type an `unmapped_entry` diagnostic counts. */
  entryType?: string;
  message: string;
}
