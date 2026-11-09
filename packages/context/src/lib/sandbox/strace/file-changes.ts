import type {
  Experimental_SandboxProcess,
  Experimental_SandboxSpawnOptions,
  Experimental_SandboxSpawnOptionsWithStdin,
  Experimental_SandboxSpawnOptionsWithoutStdin,
  Experimental_WritableSandboxProcess,
} from '@ai-sdk/provider-utils';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { BashException } from '../bash-exception.ts';
import { fromLegacySandbox } from '../legacy-sandbox.ts';
import { shellQuote } from '../shell-quote.ts';
import type {
  CommandResult,
  DisposableSandbox,
  LegacySandbox,
} from '../types.ts';
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
 * A `with*` decorator that wraps the sandbox so each `run` is traced and its
 * filesystem mutations parsed into a per-call `FileChange[]`. Per-call
 * attribution is structural — one UUID-keyed trace file per call — so it is safe
 * under concurrent tool calls. Each call's manifest is surfaced two stateless
 * ways: attached directly to the command result as `meta.fileChanges` and passed
 * to `onFileChanges`. No buffer is retained.
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
 * Reads, `stat` and `listDirectory` pass through unchanged. `writeFile`,
 * `writeBinaryFile` and `writeTextFile` are observed directly (they mutate
 * outside strace's view) — a written file matching the `include`/`exclude` globs
 * becomes a `write` change fed to onFileChanges. `deleteFile` passes through
 * unobserved. `dispose` also sweeps the trace dir. `spawn` is traced the same way
 * as `run` — its trace is read when the process exits (strace is the top process,
 * so the trace is fully flushed by then). `spawn` has no command result, so its
 * changes go to `onFileChanges` only.
 *
 * The trace file is always swept once parsed. A throwing `onFileChanges` on the
 * tool-call path propagates to the bash tool one level up: a caller's
 * `BashException` becomes the tool result (via its `format()`), any other error
 * fails the tool call. The `spawn` path has no exception catcher, so its throw is
 * isolated and surfaced only via `onError`.
 */
export async function withStraceFileChanges(
  sandbox: DisposableSandbox | LegacySandbox,
  options: WithStraceFileChangesOptions,
): Promise<DisposableSandbox> {
  const { include, exclude, onFileChanges } = options;
  const onError = options.onError ?? warnOnFileChangesError;
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const inner = 'run' in sandbox ? sandbox : fromLegacySandbox(sandbox);

  // Delete the trace file with a fresh run (no caller signal) so an aborted turn
  // can't cancel the cleanup and leave the file behind.
  const removeTrace = (traceFile: string) =>
    void Promise.resolve(
      inner.run({ command: `rm -f ${shellQuote(traceFile)}` }),
    ).catch(() => {});

  // Parse one call's changes and sweep its trace file — the trace is consumed
  // once parsed, so it's deleted here regardless of what the caller's callback
  // does next. Returns [] on an empty or unparseable trace.
  const readChanges = async (traceFile: string): Promise<FileChange[]> => {
    try {
      const trace = await inner.readTextFile({ path: traceFile });
      return trace === null
        ? []
        : parseStraceTrace(trace, { include, exclude, traceFile, traceDir });
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

  let baseDirectory: Promise<string> | undefined;
  const absolutePath = async (path: string): Promise<string> => {
    if (posix.isAbsolute(path)) return posix.normalize(path);
    baseDirectory ??= Promise.resolve(inner.run({ command: 'pwd' })).then(
      ({ stdout }) => stdout.trimEnd(),
    );
    return posix.resolve(await baseDirectory, path);
  };

  // The write methods mutate the filesystem outside strace's view, so observe
  // them directly: synthesize a `write` change (under the observation root) and
  // run it through onFileChanges. A throw propagates to the writeFile tool's
  // execute (which rejects), the same gate as the bash path — except there's no
  // CommandResult here, so throw a plain Error to reject; BashException.format()
  // is meaningful only for bash commands.
  const observeWrite = async (filePath: string): Promise<void> => {
    const path = await absolutePath(filePath);
    if (!matchesGlobs(path, include, exclude)) return;
    await onFileChanges?.([{ op: 'write', path, timestamp: Date.now() }]);
  };

  function spawn(
    options: Experimental_SandboxSpawnOptionsWithStdin,
  ): Promise<Experimental_WritableSandboxProcess>;
  function spawn(
    options: Experimental_SandboxSpawnOptionsWithoutStdin,
  ): Promise<Experimental_SandboxProcess>;
  function spawn(
    options: Experimental_SandboxSpawnOptions,
  ): Promise<Experimental_SandboxProcess | Experimental_WritableSandboxProcess>;
  async function spawn(
    spawnOptions: Experimental_SandboxSpawnOptions,
  ): Promise<
    Experimental_SandboxProcess | Experimental_WritableSandboxProcess
  > {
    const traceFile = `${traceDir}/${randomUUID()}.strace`;
    const child = await inner.spawn({
      ...spawnOptions,
      command: buildStraceCommand(spawnOptions.command, traceFile, traceDir),
    });
    // collectSpawn is the isolation boundary: never let it (e.g. a throwing
    // onError) reject and mask the real exit result.
    const exit = Promise.resolve(child.wait()).finally(() =>
      collectSpawn(traceFile).catch(() => {}),
    );
    // An abort rejects `exit` before the caller asks for it.
    exit.catch(() => {});
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      ...('stdin' in child ? { stdin: child.stdin } : {}),
      wait: () => exit,
      kill: () => child.kill(),
    };
  }

  const dispose = async (): Promise<void> => {
    await Promise.resolve(
      inner.run({ command: `rm -rf ${shellQuote(traceDir)}` }),
    ).catch(() => {});
    await inner.dispose();
  };

  return {
    description: inner.description,
    async run(runOptions) {
      const traceFile = `${traceDir}/${randomUUID()}.strace`;
      const sentinel = `__dat_trace_${randomUUID()}__`;
      const wrapped = buildTracedCommand(
        runOptions.command,
        traceFile,
        traceDir,
        sentinel,
      );
      let raw: CommandResult;
      try {
        raw = await inner.run({ ...runOptions, command: wrapped });
      } catch (error) {
        // The command failed at the sandbox level; the inline `rm` never ran, so
        // sweep the trace and surface the real error.
        removeTrace(traceFile);
        throw error;
      }
      // The trace rides back inline on stdout after the sentinel — one exec, no
      // separate read round-trip. strace's own diagnostics (prefixed `strace: `)
      // share the command's stderr fd; strip them.
      const { stdout, trace } = splitTracedOutput(raw.stdout, sentinel);
      const result: CommandResult = {
        ...raw,
        stdout,
        stderr: stripStraceDiagnostics(raw.stderr),
      };
      // On abort the caller discards this command's changes; skip onFileChanges.
      if (runOptions.abortSignal?.aborted) return result;
      const changes = trace
        ? parseStraceTrace(trace, { include, exclude, traceFile, traceDir })
        : [];
      if (changes.length) {
        // A throwing onFileChanges propagates to the bash tool, which turns a
        // BashException into the tool result, or fails the call for any other
        // error.
        try {
          await onFileChanges?.(changes);
        } catch (error) {
          if (!(error instanceof BashException)) throw error;
          const formatted = error.format();
          return {
            ...formatted,
            meta: { ...result.meta, ...formatted.meta, fileChanges: changes },
          };
        }
        return {
          ...result,
          meta: { ...result.meta, fileChanges: changes },
        };
      }
      return result;
    },
    spawn,
    readFile: (readOptions) => inner.readFile(readOptions),
    readBinaryFile: (readOptions) => inner.readBinaryFile(readOptions),
    readTextFile: (readOptions) => inner.readTextFile(readOptions),
    stat: (statOptions) => inner.stat(statOptions),
    listDirectory: (listOptions) => inner.listDirectory(listOptions),
    deleteFile: (deleteOptions) => inner.deleteFile(deleteOptions),
    writeFile: async (writeOptions) => {
      await inner.writeFile(writeOptions);
      await observeWrite(writeOptions.path);
    },
    writeBinaryFile: async (writeOptions) => {
      await inner.writeBinaryFile(writeOptions);
      await observeWrite(writeOptions.path);
    },
    writeTextFile: async (writeOptions) => {
      await inner.writeTextFile(writeOptions);
      await observeWrite(writeOptions.path);
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
