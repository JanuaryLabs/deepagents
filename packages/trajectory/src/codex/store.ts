import {
  CODEX_ROLLOUT_DIRS,
  parseRolloutFileName,
  parseSessionMetaLine,
} from '@alwaysmeticulous/agent-traces';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

import { CodexThread } from './thread.ts';

interface Rollout {
  path: string;
  rolloutId: string;
  timestamp: string;
  changed: number;
}

interface Thread {
  threadId: string;
  parentId: string | null;
  rollouts: Rollout[];
}

/**
 * A Codex store: the folder that holds `sessions/` and `archived_sessions/`.
 * The root is required, and nothing here reads the home folder, the
 * environment or the clock (ADR 0005).
 */
export class CodexStore {
  readonly root: string;

  constructor(options: { root: string }) {
    this.root = options.root;
  }

  /**
   * Each root thread with a rollout changed at or after `since`, newest first.
   * A rollout is `.jsonl` or `.jsonl.zst`. It reads each rollout's first line
   * (`session_meta`) to group a subagent thread under its parent, as
   * meticulous does: the parent is the meta's `session_id` when it differs
   * from the thread id, else its `parent_thread_id`, followed while the parent
   * is among the files, so an orphan is its own root.
   */
  async *threads(options: { since: Date }): AsyncIterable<CodexThread> {
    const since = options.since.getTime();
    const threads = new Map<string, Thread>();
    for (const folder of CODEX_ROLLOUT_DIRS) {
      for (const path of await rolloutFiles(join(this.root, folder))) {
        const changed = (await stat(path)).mtimeMs;
        if (changed < since) continue;
        const named = parseRolloutFileName(
          basename(path).replace(/\.zst$/, ''),
        );
        const meta = parseSessionMetaLine(await firstLine(path));
        const threadId = meta?.threadId ?? named?.threadId ?? basename(path);
        const thread = threads.get(threadId) ?? {
          threadId,
          parentId: null,
          rollouts: [],
        };
        thread.rollouts.push({
          path,
          rolloutId: named?.rolloutId ?? threadId,
          timestamp: named?.timestamp ?? '',
          changed,
        });
        thread.parentId ??=
          meta?.sessionId && meta.sessionId !== threadId
            ? meta.sessionId
            : (meta?.parentThreadId ?? null);
        threads.set(threadId, thread);
      }
    }

    const groups = new Map<string, Thread[]>();
    for (const thread of threads.values()) {
      const rootId = rootOf(thread.threadId, threads);
      groups.set(rootId, [...(groups.get(rootId) ?? []), thread]);
    }
    const roots = [...groups].map(([rootId, members]) => ({
      rootId,
      members,
      changed: Math.max(
        ...members.flatMap((member) => member.rollouts.map((r) => r.changed)),
      ),
    }));
    for (const { rootId, members } of roots.toSorted(
      (a, b) => b.changed - a.changed,
    )) {
      const root = members.find((member) => member.threadId === rootId);
      if (!root) continue;
      yield new CodexThread(
        rootId,
        ordered(root),
        members
          .filter((member) => member !== root)
          .map((member) => ({
            threadId: member.threadId,
            rolloutPaths: ordered(member),
          })),
      );
    }
  }
}

/** A thread's original rollout precedes those a revert wrote (meticulous's `compareRollouts`). */
function ordered(thread: Thread): string[] {
  return thread.rollouts
    .toSorted(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        Number(a.rolloutId !== thread.threadId) -
          Number(b.rolloutId !== thread.threadId) ||
        a.rolloutId.localeCompare(b.rolloutId),
    )
    .map((rollout) => rollout.path);
}

/** Follows parents while they're among the files, so an orphan is its own root (meticulous's `findRootId`). */
function rootOf(threadId: string, threads: Map<string, Thread>): string {
  const seen = new Set([threadId]);
  let current = threadId;
  for (;;) {
    const parentId = threads.get(current)?.parentId;
    if (!parentId || !threads.has(parentId) || seen.has(parentId))
      return current;
    seen.add(parentId);
    current = parentId;
  }
}

async function rolloutFiles(folder: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(folder, { recursive: true });
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => /^rollout-.+\.jsonl(\.zst)?$/.test(basename(name)))
    .map((name) => join(folder, name));
}

/** The first line of a rollout, decompressing a `.zst` only as far as that line; null when it cannot be read. */
async function firstLine(path: string): Promise<string | null> {
  const file = createReadStream(path);
  const input = path.endsWith('.zst')
    ? file.pipe(createZstdDecompress())
    : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    file.destroy();
    input.destroy();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
