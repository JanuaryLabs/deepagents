/** A subagent thread under a Codex thread. */
export interface CodexSubagentThread {
  readonly threadId: string;
  /** The thread's rollout files, the original first, then any a revert wrote. */
  readonly rolloutPaths: readonly string[];
}

/**
 * One Codex thread as its rollout files hold it: `<root>/sessions/…/rollout-*.jsonl[.zst]`
 * and `archived_sessions/`, with the threads it spawned. `CodexStore.threads()`
 * builds it from each rollout's `session_meta`.
 */
export class CodexThread {
  readonly threadId: string;
  /** The thread's rollout files, the original first, then any a revert wrote. */
  readonly rolloutPaths: readonly string[];
  /** Every thread under this one (subagents of subagents too), flat. */
  readonly subagents: readonly CodexSubagentThread[];

  constructor(
    threadId: string,
    rolloutPaths: readonly string[],
    subagents: readonly CodexSubagentThread[] = [],
  ) {
    this.threadId = threadId;
    this.rolloutPaths = rolloutPaths;
    this.subagents = subagents;
  }
}
