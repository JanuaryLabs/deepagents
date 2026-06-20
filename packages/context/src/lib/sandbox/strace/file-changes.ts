import type { CommandResult } from 'bash-tool';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { useBashMeta } from '../bash-meta.ts';
import { shellQuote } from '../shell-quote.ts';
import type { DisposableSandbox } from '../types.ts';
import type { FileChange } from './file-change.ts';
import {
  buildStraceCommand,
  buildTracedCommand,
  matchesGlobs,
  parseStraceTrace,
  splitTracedOutput,
} from './index.ts';

export type { FileChange, FileChangeOp } from './file-change.ts';

const DEFAULT_TRACE_DIR = '/tmp/dat-trace';

/** Drop strace's own diagnostic lines (prefixed `strace: `) from captured stderr. */
function stripStraceDiagnostics(stderr: string): string {
  if (!stderr.includes('strace: ')) return stderr;
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('strace: '))
    .join('\n');
}

export interface WithStraceFileChangesOptions {
  /**
   * Glob patterns (matched against absolute paths via Node's
   * `path.matchesGlob`) selecting which file changes to report. Scope to a
   * workspace with `[root, `${root}/**`]`. A path must match at least one
   * pattern to be reported.
   */
  include: string[];
  /**
   * Glob patterns subtracted from `include` — a path matching any of these is
   * dropped even if it also matches `include`. Use to keep framework-written
   * files (e.g. an uploaded skills directory) out of the change stream.
   */
  exclude?: string[];
  onFileChanges?: (changes: FileChange[]) => void | Promise<void>;
  /**
   * Called when `onFileChanges` throws on the `spawn` path — its only failure
   * signal, since spawn has no tool result and no exception catcher upstream. A
   * throw on the tool-call path fails the command instead, so it never reaches
   * here. Defaults to `console.warn`.
   */
  onError?: (error: unknown) => void;
  traceDir?: string;
}

function warnOnFileChangesError(error: unknown): void {
  console.warn(
    '[withStraceFileChanges] onFileChanges threw on spawn; isolated',
    error,
  );
}

/**
 * A `with*` decorator that wraps the sandbox so each `executeCommand` is traced
 * and its filesystem mutations parsed into a per-call `FileChange[]`. Per-call
 * attribution is structural — one UUID-keyed trace file per call — so it is safe under
 * concurrent tool calls. Each call's manifest is surfaced two stateless ways: attached to
 * the tool result via the bash-meta channel (`meta.fileChanges`, hidden from the
 * model) and passed to `onFileChanges`. No buffer is retained.
 *
 * This decorator lives on the main barrel (not the lean `./sandbox/strace`
 * leaf) on purpose: the `meta.fileChanges` channel works by sharing one
 * `bash-meta` AsyncLocalStorage with `createBashTool`, and AsyncLocalStorage
 * context does not cross bundle boundaries — so the decorator must be bundled
 * with `createBashTool`. The leaf carries only the self-contained probe.
 *
 * This decorator TRUSTS that strace tracing works in the sandbox; it does not
 * self-test. "strace works here" is an invariant of the (image + host kernel +
 * seccomp/caps) that is constant for the container's lifetime, so verifying it
 * is the consumer's once-per-container responsibility — run `selfTestStrace`
 * (from `@deepagents/context/sandbox/strace`) once at startup (e.g. a daemon
 * boot gate), which throws `StraceUnavailableError` if strace is unusable.
 * Re-proving it per composition would re-pay several host→container round-trips
 * on every tool call for no new information.
 *
 * `readFile` passes through unchanged; `writeFiles` is observed directly (it
 * mutates outside strace's view) — each written file matching the
 * `include`/`exclude` globs becomes a `write` change fed to onFileChanges.
 * `dispose` also sweeps the trace
 * dir. `spawn` is traced the same way — its trace is read when the process exits
 * (strace is the top process, so the trace is fully flushed by then). `spawn`
 * carries no bash-meta scope, so its changes go to `onFileChanges` only.
 *
 * The trace file is always swept once parsed. A throwing `onFileChanges` on the
 * tool-call path propagates to `withBashExceptionCatch` one level up: a caller's
 * `BashException` becomes the tool result (via its `format()`), any other error
 * fails the tool call. The `spawn` path has no exception catcher, so its throw is
 * isolated and surfaced only via `onError`.
 */
export async function withStraceFileChanges(
  sandbox: DisposableSandbox,
  options: WithStraceFileChangesOptions,
): Promise<DisposableSandbox> {
  const { include, exclude, onFileChanges } = options;
  const onError = options.onError ?? warnOnFileChangesError;
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const innerExecute = sandbox.executeCommand.bind(sandbox);
  const innerReadFile = sandbox.readFile.bind(sandbox);
  const innerWriteFiles = sandbox.writeFiles.bind(sandbox);

  // Delete the trace file with a fresh executeCommand (no caller signal) so an
  // aborted turn can't cancel the cleanup and leave the file behind.
  const removeTrace = (traceFile: string) =>
    void innerExecute(`rm -f ${shellQuote(traceFile)}`).catch(() => {});

  // Parse one call's changes and sweep its trace file — the trace is consumed
  // once parsed, so it's deleted here regardless of what the caller's callback
  // does next. Returns [] on an empty or unparseable trace.
  const readChanges = async (traceFile: string): Promise<FileChange[]> => {
    try {
      return parseStraceTrace(await innerReadFile(traceFile), {
        include,
        exclude,
        traceFile,
        traceDir,
      });
    } catch {
      return [];
    } finally {
      removeTrace(traceFile);
    }
  };

  // Spawn path: no tool result and no exception catcher upstream, so a callback
  // throw is isolated here and surfaced only via `onError`.
  const collectSpawn = async (traceFile: string): Promise<void> => {
    const changes = await readChanges(traceFile);
    if (!changes.length || !onFileChanges) return;
    try {
      await onFileChanges(changes);
    } catch (error) {
      onError(error);
    }
  };

  const decorated: DisposableSandbox = {
    async executeCommand(command, execOptions) {
      const traceFile = `${traceDir}/${randomUUID()}.strace`;
      const sentinel = `__dat_trace_${randomUUID()}__`;
      const wrapped = buildTracedCommand(
        command,
        traceFile,
        traceDir,
        sentinel,
      );
      let raw: CommandResult;
      try {
        raw = await innerExecute(wrapped, execOptions);
      } catch (error) {
        // The command failed at the sandbox level; the inline `rm` never ran, so
        // sweep the trace and surface the real error.
        removeTrace(traceFile);
        throw error;
      }
      // The trace rides back inline on stdout after the sentinel — one exec, no
      // separate readFile round-trip. strace's own diagnostics (prefixed
      // `strace: `) share the command's stderr fd; strip them.
      const { stdout, trace } = splitTracedOutput(raw.stdout, sentinel);
      const result: CommandResult = {
        ...raw,
        stdout,
        stderr: stripStraceDiagnostics(raw.stderr),
      };
      // On abort the caller discards this command's changes; skip onFileChanges.
      if (execOptions?.signal?.aborted) return result;
      const changes = trace
        ? parseStraceTrace(trace, { include, exclude, traceFile, traceDir })
        : [];
      // A throwing onFileChanges propagates here; the catcher one level up
      // (withBashExceptionCatch) turns a BashException into the tool result, or
      // fails the call for any other error.
      if (changes.length) {
        useBashMeta()?.setHidden({ fileChanges: changes });
        await onFileChanges?.(changes);
      }
      return result;
    },
    readFile: innerReadFile,
    // The writeFile tool mutates the filesystem outside strace's view, so
    // observe it directly: synthesize a `write` change per file (under the
    // observation root) and run it through onFileChanges. A throw propagates to
    // the writeFile tool's execute (which rejects), the same gate as the bash
    // path — except there's no CommandResult here, so throw a plain Error to
    // reject; BashException.format() is meaningful only for bash commands.
    writeFiles: async (files) => {
      await innerWriteFiles(files);
      const now = Date.now();
      // Upstream bash-tool resolves writeFile paths to absolute before they
      // reach here, so match the include/exclude globs against them directly.
      const changes = files
        .map((f) => posix.normalize(f.path))
        .filter((path) => matchesGlobs(path, include, exclude))
        .map((path): FileChange => ({ op: 'write', path, timestamp: now }));
      if (changes.length) await onFileChanges?.(changes);
    },
    dispose: async () => {
      await innerExecute(`rm -rf ${shellQuote(traceDir)}`).catch(() => {});
      await sandbox.dispose();
    },

    [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
      return this.dispose();
    },
  };

  if (sandbox.spawn) {
    const innerSpawn = sandbox.spawn.bind(sandbox);
    decorated.spawn = (command, spawnOptions) => {
      const traceFile = `${traceDir}/${randomUUID()}.strace`;
      const child = innerSpawn(
        buildStraceCommand(command, traceFile, traceDir),
        spawnOptions,
      );
      const exit = (async () => {
        try {
          return await child.exit;
        } finally {
          // collectSpawn is the isolation boundary: never let it (e.g. a
          // throwing onError) reject and mask the real exit result.
          await collectSpawn(traceFile).catch(() => {});
        }
      })();
      return { stdout: child.stdout, stderr: child.stderr, exit };
    };
  }

  return decorated;
}
