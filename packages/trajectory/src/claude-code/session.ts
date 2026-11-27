import { basename, dirname, join } from 'node:path';

const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;

/** Only the store places a session in a chain; the package index does not export this key. */
export const placeInChain = Symbol('placeInChain');

/**
 * One Claude Code session: `<root>/projects/<project>/<session-id>.jsonl` and
 * its `<session-id>/subagents/` folder. Building one touches no disk.
 */
export class ClaudeCodeSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  /** The run this segment belongs to: the first session id of its /clear chain (ADR 0007). */
  readonly runId: string;
  /** The next segment's transcript, when the chain continues after this one. */
  readonly continuedBy: string | undefined;

  private constructor(
    sessionId: string,
    transcriptPath: string,
    runId: string,
    continuedBy: string | undefined,
  ) {
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;
    this.runId = runId;
    this.continuedBy = continuedBy;
  }

  /** The session of a main transcript path, such as a hook's `transcript_path`. */
  static fromTranscriptPath(path: string): ClaudeCodeSession {
    const name = basename(path);
    if (!name.endsWith('.jsonl') || basename(dirname(path)) === 'subagents') {
      throw new TypeError(
        `not a Claude Code main transcript (expected <session-id>.jsonl; a subagent file is a ClaudeCodeSubagent): ${path}`,
      );
    }
    const sessionId = name.slice(0, -'.jsonl'.length);
    return new ClaudeCodeSession(sessionId, path, sessionId, undefined);
  }

  /** The chain gives each segment its run and its successor. */
  static [placeInChain](
    session: ClaudeCodeSession,
    runId: string,
    continuedBy: string | undefined,
  ): ClaudeCodeSession {
    return new ClaudeCodeSession(
      session.sessionId,
      session.transcriptPath,
      runId,
      continuedBy,
    );
  }

  /** The folder that holds this session's subagent transcripts. */
  get subagentsPath(): string {
    return join(dirname(this.transcriptPath), this.sessionId, 'subagents');
  }
}

/**
 * One subagent's transcript: `<session-id>/subagents/agent-<agent-id>.jsonl`,
 * with its `.meta.json` beside it. A SubagentStop hook reads it from
 * `agent_transcript_path`. Building one touches no disk.
 */
export class ClaudeCodeSubagent {
  readonly agentId: string;
  /** The session that started this subagent. */
  readonly sessionId: string;
  readonly transcriptPath: string;

  private constructor(
    agentId: string,
    sessionId: string,
    transcriptPath: string,
  ) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;
  }

  /** The subagent of a subagent transcript path, such as a hook's `agent_transcript_path`. */
  static fromTranscriptPath(path: string): ClaudeCodeSubagent {
    const match = SUBAGENT_FILE.exec(basename(path));
    const subagents = dirname(path);
    if (!match || basename(subagents) !== 'subagents') {
      throw new TypeError(
        `not a Claude Code subagent transcript (expected <session-id>/subagents/agent-<id>.jsonl): ${path}`,
      );
    }
    return new ClaudeCodeSubagent(match[1], basename(dirname(subagents)), path);
  }

  /** The `.meta.json` file beside the transcript, which names the call that spawned it. */
  get metaPath(): string {
    return this.transcriptPath.replace(/\.jsonl$/, '.meta.json');
  }

  /** ATIF's per-document id of this subagent's trajectory. */
  get trajectoryId(): string {
    return `agent-${this.agentId}`;
  }
}
