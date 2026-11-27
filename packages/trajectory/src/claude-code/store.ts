import { open, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SessionReadError } from '../errors.ts';
import { ClaudeCodeSession, placeInChain } from './session.ts';

/** The segments of one Claude Code session across /clear, and the ids it names whose transcript is gone. */
export interface ClaudeCodeChain {
  /** Oldest first. */
  readonly sessions: readonly ClaudeCodeSession[];
  /** Ids a `derived-from` entry names whose transcript is not in the store. */
  readonly missing: readonly string[];
}

/** A listed session and what its transcript's head records, as the Claude Agent SDK's `listSessions` gives `SDKSessionInfo`. */
export interface ClaudeCodeSessionInfo {
  readonly session: ClaudeCodeSession;
  /** The first `cwd` an entry in the transcript's first 64 KB records; undefined when none does or the transcript cannot be read. */
  readonly cwd: string | undefined;
}

/** How much of a transcript a listing reads: the Agent SDK's lite read takes the same 64 KB. */
const HEAD_BYTES = 64 * 1024;

/**
 * A Claude Code store: the folder that holds `projects/`. The root is
 * required, and nothing here reads the home folder, the environment or the
 * clock (ADR 0005).
 */
export class ClaudeCodeStore {
  readonly root: string;

  constructor(options: { root: string }) {
    this.root = options.root;
  }

  /**
   * Each main transcript (`projects/<project>/<id>.jsonl`) changed at or after
   * `since`, newest first, with the first `cwd` of its first 64 KB (ADR 0008's
   * amendment). It never reads a whole transcript, and subagent transcripts are
   * not sessions.
   */
  async *sessions(options: {
    since: Date;
  }): AsyncIterable<ClaudeCodeSessionInfo> {
    const since = options.since.getTime();
    const found: { path: string; changed: number }[] = [];
    for (const project of await this.#projects()) {
      for (const name of await listOrEmpty(project)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(project, name);
        const changed = (await stat(path)).mtimeMs;
        if (changed >= since) found.push({ path, changed });
      }
    }
    for (const { path } of found.toSorted((a, b) => b.changed - a.changed)) {
      yield {
        session: ClaudeCodeSession.fromTranscriptPath(path),
        cwd: await headCwd(path),
      };
    }
  }

  /** The session whose transcript a project holds, or undefined when none does. */
  async session(sessionId: string): Promise<ClaudeCodeSession | undefined> {
    if (!isSessionId(sessionId)) return undefined;
    for (const project of await this.#projects()) {
      const path = join(project, `${sessionId}.jsonl`);
      if (await isFile(path)) return ClaudeCodeSession.fromTranscriptPath(path);
    }
    return undefined;
  }

  /**
   * The segments of the session's /clear chain, oldest first (ADR 0007, as
   * agent-plugin housekeeping's `lib/session.mjs` walks it). It follows every
   * `claude_code_session` a `derived-from` entry names, whatever its `via`,
   * skips ids already in the chain (a resume names its own session), and looks
   * beside the current transcript before every project. Each segment carries
   * the chain's first id as its run and the next segment's transcript.
   */
  async chain(session: ClaudeCodeSession): Promise<ClaudeCodeChain> {
    const seen = new Set<string>();
    const found: ClaudeCodeSession[] = [];
    const missing: string[] = [];
    const queue: { id: string; segment: ClaudeCodeSession | undefined }[] = [
      { id: session.sessionId, segment: session },
    ];
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      if (!next.segment) {
        missing.push(next.id);
        continue;
      }
      found.push(next.segment);
      for (const id of await derivedFrom(next.segment.transcriptPath)) {
        if (seen.has(id)) continue;
        const beside = join(
          dirname(next.segment.transcriptPath),
          `${id}.jsonl`,
        );
        const segment =
          isSessionId(id) && (await isFile(beside))
            ? ClaudeCodeSession.fromTranscriptPath(beside)
            : await this.session(id);
        queue.push({ id, segment });
      }
    }

    const oldestFirst = found.toReversed();
    const runId = oldestFirst[0]?.sessionId ?? session.sessionId;
    return {
      sessions: oldestFirst.map((segment, index) =>
        ClaudeCodeSession[placeInChain](
          segment,
          runId,
          oldestFirst[index + 1]?.transcriptPath,
        ),
      ),
      missing,
    };
  }

  async #projects(): Promise<string[]> {
    const projects = join(this.root, 'projects');
    const names = await listOrEmpty(projects);
    return names.map((name) => join(projects, name));
  }
}

/** The session ids a transcript's `derived-from` entries name. */
async function derivedFrom(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new SessionReadError(path, 'could not read the transcript', {
      cause,
    });
  }
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"derived-from"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isRecord(entry) ||
      entry.type !== 'derived-from' ||
      !Array.isArray(entry.sessions)
    ) {
      continue;
    }
    for (const from of entry.sessions) {
      if (
        isRecord(from) &&
        from.type === 'claude_code_session' &&
        typeof from.id === 'string'
      ) {
        ids.push(from.id);
      }
    }
  }
  return ids;
}

/**
 * The first `cwd` an entry of the transcript's first 64 KB records. A line the
 * limit cuts is not read; a transcript the process cannot open (gone since the
 * listing saw it, or locked) records none.
 */
async function headCwd(path: string): Promise<string | undefined> {
  await using file = await open(path).catch((error: unknown) => {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'EACCES') return undefined;
    throw error;
  });
  if (file === undefined) return undefined;
  const head = Buffer.alloc(HEAD_BYTES);
  const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);
  for (const line of head.toString('utf8', 0, bytesRead).split('\n')) {
    if (!line.includes('"cwd"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(entry) && typeof entry.cwd === 'string') return entry.cwd;
  }
  return undefined;
}

/** A folder's entries, or none when the folder does not exist or is not a folder. */
async function listOrEmpty(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** A session id names a file in a project folder, never a path out of it. */
function isSessionId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..' && !/[/\\]/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
