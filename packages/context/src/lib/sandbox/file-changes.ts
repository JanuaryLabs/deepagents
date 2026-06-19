import type { CommandResult } from 'bash-tool';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { useBashMeta } from './bash-meta.ts';
import { shellQuote } from './installers/index.ts';
import type { DisposableSandbox } from './types.ts';

/**
 * A single filesystem mutation observed for one tool call. Ops are
 * deliberately coarse: strace cannot distinguish a brand-new file from an
 * overwrite within a single command (both are `O_CREAT|O_TRUNC`), so
 * content-touching syscalls collapse to `write`. `delete` and `rename` are
 * unambiguous. Reads are not tracked — strace's syscall filter excludes them.
 */
export type FileChangeOp = 'write' | 'delete' | 'rename';

export interface FileChange {
  op: FileChangeOp;
  path: string;
  /** Source path for a `rename`. */
  from?: string;
  timestamp: number;
}

export type StraceUnavailableReason =
  | 'ptrace-blocked'
  | 'strace-missing'
  | 'trace-unparseable';

const REASON_HINT: Record<StraceUnavailableReason, string> = {
  'ptrace-blocked':
    'ptrace is denied by the sandbox runtime. Modern Docker permits it by default; on a hardened host, relax the runtime seccomp/ptrace policy (allow the ptrace syscall, or add the SYS_PTRACE capability).',
  'strace-missing':
    'strace is not installed in the sandbox image. Bake `strace` into the image.',
  'trace-unparseable':
    'strace ran but its output is unusable — the sandbox is likely running under emulation (e.g. amd64 via Rosetta). Use a native-architecture sandbox.',
};

/**
 * Thrown by {@link selfTestStrace} when per-command strace tracking cannot be
 * used. `reason` lets callers branch (fix-image vs fix-caps vs fix-arch). This
 * is a hard failure by design — there is no silent degrade to the snapshot
 * observer.
 */
export class StraceUnavailableError extends Error {
  readonly reason: StraceUnavailableReason;
  readonly diagnostics: string;

  constructor(reason: StraceUnavailableReason, diagnostics: string) {
    super(
      `strace file-change tracking unavailable (${reason}): ${REASON_HINT[reason]}`,
    );
    this.name = 'StraceUnavailableError';
    this.reason = reason;
    this.diagnostics = diagnostics;
  }
}

const DEFAULT_TRACE_DIR = '/tmp/dat-trace';
const STRACE_FLAGS = '-f -y -qq -e trace=%file,write,pwrite64,writev';

/**
 * Wraps `command` so its filesystem syscalls are traced to `traceFile`. Both
 * the inner command and this wrapper are re-parsed by a shell (`sh -c`), so the
 * single-quoting via {@link shellQuote} composes with the backend's own
 * `sh -c`. strace propagates the traced command's exit code. The `mkdir -p`
 * runs before strace (so it isn't traced) and self-heals the trace dir per
 * command — if it ever disappears mid-session, the next command recreates it
 * rather than strace failing to open `-o` and skipping the command entirely.
 */
function buildStraceCommand(
  command: string,
  traceFile: string,
  traceDir: string,
): string {
  return (
    `mkdir -p ${shellQuote(traceDir)} 2>/dev/null; ` +
    `strace ${STRACE_FLAGS} -o ${shellQuote(traceFile)} -- sh -c ${shellQuote(command)}`
  );
}

/** Drop strace's own diagnostic lines (prefixed `strace: `) from captured stderr. */
function stripStraceDiagnostics(stderr: string): string {
  if (!stderr.includes('strace: ')) return stderr;
  return stderr
    .split('\n')
    .filter((line) => !line.startsWith('strace: '))
    .join('\n');
}

// An open is a definite write only when it creates or truncates. Bare
// O_WRONLY/O_RDWR/O_APPEND opens are NOT assumed to mutate — a real write()
// syscall confirms them — so read-only-via-O_RDWR (sqlite SELECT, an editor
// that opens then quits) doesn't produce a phantom `write`.
const CREATE_OR_TRUNC_FLAGS = /O_(CREAT|TRUNC)/;
const RENAME_SYSCALLS = new Set(['rename', 'renameat', 'renameat2']);
const DELETE_SYSCALLS = new Set(['unlink', 'unlinkat', 'rmdir']);
const MKDIR_SYSCALLS = new Set(['mkdir', 'mkdirat']);
const LINK_SYSCALLS = new Set(['link', 'linkat', 'symlink', 'symlinkat']);
const OPEN_SYSCALLS = new Set(['open', 'openat', 'openat2', 'creat']);
const WRITE_SYSCALLS = new Set([
  'write',
  'pwrite64',
  'pwrite',
  'writev',
  'pwritev2',
]);
const TRUNCATE_SYSCALLS = new Set(['truncate', 'ftruncate']);

interface ParsedCall {
  syscall: string;
  args: string;
  retval: string;
  errno?: string;
}

/** Reassemble `<unfinished …>` / `<… resumed>` syscall splits per PID. */
function stitchLines(raw: string): string[] {
  const pending = new Map<string, string>();
  const out: string[] = [];
  for (const original of raw.split('\n')) {
    const line = original.trimEnd();
    if (!line) continue;
    const pid = line.match(/^\s*(\d+)\s+/)?.[1] ?? '0';
    if (/<unfinished \.\.\.>\s*$/.test(line)) {
      pending.set(pid, line.replace(/<unfinished \.\.\.>\s*$/, ''));
      continue;
    }
    const resumed = line.match(/<\.\.\.\s+\S+\s+resumed>(.*)$/);
    if (resumed) {
      const head = pending.get(pid);
      pending.delete(pid);
      if (head !== undefined) out.push(head + resumed[1]);
      continue;
    }
    out.push(line);
  }
  return out;
}

function parseCall(line: string): ParsedCall | null {
  const m = line.match(
    /^\s*(?:\d+\s+)?([a-z_][a-z0-9_]*)\((.*)\)\s*=\s*(.+?)\s*$/,
  );
  if (!m) return null;
  const [, syscall, args, rest] = m;
  const errnoMatch = rest.match(/^(-?\d+)\s+([A-Z][A-Z0-9_]*)/);
  if (errnoMatch) {
    return { syscall, args, retval: errnoMatch[1], errno: errnoMatch[2] };
  }
  return { syscall, args, retval: rest.split(/\s+/)[0] };
}

const STRACE_ESCAPE: Record<string, number> = {
  n: 0x0a,
  t: 0x09,
  r: 0x0d,
  v: 0x0b,
  f: 0x0c,
  '"': 0x22,
  '\\': 0x5c,
};

/**
 * Decode one strace-rendered string. strace emits printable ASCII verbatim and
 * non-printable / non-ASCII bytes as octal `\NNN`, plus a few `\x` escapes. We
 * reconstruct the raw byte sequence and decode it as UTF-8 so multi-byte
 * filenames (e.g. `café.txt` → `\303\251`) round-trip instead of being mangled.
 */
function decodeStraceString(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const octal = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8) & 0xff);
        i += 1 + octal.length;
        continue;
      }
      const mapped = STRACE_ESCAPE[s[i + 1]];
      bytes.push(mapped ?? s.charCodeAt(i + 1));
      i += 2;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes.push(code);
    else for (const b of Buffer.from(s[i], 'utf8')) bytes.push(b);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

function quotedStrings(args: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args)) !== null) {
    out.push(decodeStraceString(m[1]));
  }
  return out;
}

/** Directory path annotated on the leading dirfd (`AT_FDCWD</cwd>` / `7</dir>`). */
function dirfdPath(args: string): string {
  return args.match(/^\s*(?:AT_FDCWD|-?\d+)<([^>]*)>/)?.[1] ?? '/';
}

/** Path annotated on the leading fd argument (`-y` output), for write syscalls. */
function fdPath(args: string): string | null {
  return args.match(/^\s*-?\d+<([^>]*)>/)?.[1] ?? null;
}

function openFlags(args: string): string {
  return args.match(/\bO_[A-Z_]+(?:\|O_[A-Z_]+)*/)?.[0] ?? '';
}

interface ParseStraceOptions {
  include: string[];
  exclude?: string[];
  traceFile?: string;
  traceDir?: string;
}

/** A path is tracked when it matches an `include` glob and no `exclude` glob. */
function matchesGlobs(
  path: string,
  include: string[],
  exclude?: string[],
): boolean {
  return (
    include.some((glob) => posix.matchesGlob(path, glob)) &&
    !exclude?.some((glob) => posix.matchesGlob(path, glob))
  );
}

/**
 * Parse one command's strace output into a coarse `FileChange[]`. Failed
 * syscalls are skipped; paths are filtered to `destination`; the trace file and
 * `/proc`,`/sys`,`/dev` are excluded. Per-path final state collapses repeated
 * writes to one `write`; a path written then deleted within the command is
 * treated as transient and dropped.
 */
function parseStraceTrace(
  raw: string,
  options: ParseStraceOptions,
): FileChange[] {
  const { include, exclude } = options;
  const traceDir = options.traceDir;
  const traceFile = options.traceFile;
  const now = Date.now();

  const state = new Map<string, 'write' | 'delete'>();
  const renames: Array<{ from: string; to: string }> = [];

  const resolve = (dir: string, p: string): string =>
    posix.normalize(p.startsWith('/') ? p : posix.join(dir, p));

  const write = (path: string) => {
    state.set(path, 'write');
  };
  const remove = (path: string) => {
    if (state.get(path) === 'write') state.delete(path);
    else state.set(path, 'delete');
  };

  for (const line of stitchLines(raw)) {
    const call = parseCall(line);
    if (!call || call.errno || call.retval === '-1') continue;
    const { syscall, args } = call;
    const dir = dirfdPath(args);

    if (RENAME_SYSCALLS.has(syscall)) {
      const strings = quotedStrings(args);
      if (strings.length < 2) continue;
      const from = resolve(dir, strings[0]);
      const to = resolve(dir, strings[strings.length - 1]);
      state.delete(from);
      renames.push({ from, to });
      continue;
    }
    if (DELETE_SYSCALLS.has(syscall)) {
      const strings = quotedStrings(args);
      if (strings.length) remove(resolve(dir, strings[0]));
      continue;
    }
    if (MKDIR_SYSCALLS.has(syscall)) {
      const strings = quotedStrings(args);
      if (strings.length) write(resolve(dir, strings[0]));
      continue;
    }
    if (LINK_SYSCALLS.has(syscall)) {
      const strings = quotedStrings(args);
      if (strings.length) write(resolve(dir, strings[strings.length - 1]));
      continue;
    }
    if (OPEN_SYSCALLS.has(syscall)) {
      if (!CREATE_OR_TRUNC_FLAGS.test(openFlags(args))) continue;
      const strings = quotedStrings(args);
      if (strings.length) write(resolve(dir, strings[0]));
      continue;
    }
    if (WRITE_SYSCALLS.has(syscall)) {
      const p = fdPath(args);
      if (p && Number(call.retval) > 0) write(posix.normalize(p));
      continue;
    }
    if (TRUNCATE_SYSCALLS.has(syscall)) {
      const p = fdPath(args) ?? quotedStrings(args)[0];
      if (p) write(resolve(dir, p));
    }
  }

  const keep = (path: string): boolean => {
    if (traceFile && path === traceFile) return false;
    if (traceDir && (path === traceDir || path.startsWith(`${traceDir}/`))) {
      return false;
    }
    if (/^\/(proc|sys|dev)(\/|$)/.test(path)) return false;
    return matchesGlobs(path, include, exclude);
  };

  const changes: FileChange[] = [];
  const emittedRenameTargets = new Set<string>();
  for (const { from, to } of renames) {
    if (!keep(to)) continue;
    // A later delete of the target supersedes the rename (the tail emits the
    // delete); otherwise the rename entry already represents the target's final
    // state, so the tail must NOT also emit a `write` for it (would duplicate).
    if (state.get(to) === 'delete') continue;
    changes.push({ op: 'rename', path: to, from, timestamp: now });
    emittedRenameTargets.add(to);
  }
  const tail: FileChange[] = [];
  for (const [path, op] of state) {
    if (emittedRenameTargets.has(path)) continue;
    if (keep(path)) tail.push({ op, path, timestamp: now });
  }
  tail.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  changes.push(...tail);
  return changes;
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

const warnOnFileChangesError = (error: unknown): void => {
  console.warn(
    '[withStraceFileChanges] onFileChanges threw on spawn; isolated',
    error,
  );
};

/**
 * A `with*` decorator that runs the strace {@link selfTestStrace} probe once
 * (throwing {@link StraceUnavailableError} if strace is unusable on this
 * backend), then decorates the sandbox so each `executeCommand` is traced and
 * its filesystem mutations parsed into a per-call `FileChange[]`. Per-call
 * attribution is structural — one trace file per `callId` — so it is safe under
 * concurrent tool calls. Each call's manifest is surfaced two stateless ways: attached to
 * the tool result via the bash-meta channel (`meta.fileChanges`, hidden from the
 * model) and passed to `onFileChanges`. No buffer is retained.
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
 * isolated and surfaced only via `onError` (exit result preserved).
 */
export async function withStraceFileChanges(
  sandbox: DisposableSandbox,
  options: WithStraceFileChangesOptions,
): Promise<DisposableSandbox> {
  await selfTestStrace(sandbox);
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

  // Tool-call path: attach the hidden meta and run the callback. A throw is NOT
  // caught — it propagates to `withBashExceptionCatch` one level up, which renders
  // a caller's BashException via its `format()` or fails the tool call for any
  // other error.
  const collectCommand = async (traceFile: string): Promise<void> => {
    const changes = await readChanges(traceFile);
    if (!changes.length) return;
    useBashMeta()?.setHidden({ fileChanges: changes });
    await onFileChanges?.(changes);
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
      const wrapped = buildStraceCommand(command, traceFile, traceDir);
      let result: CommandResult;
      try {
        const raw = await innerExecute(wrapped, execOptions);
        // strace's own diagnostics (prefixed `strace: `) share the command's
        // stderr fd; strip them so the model sees only the command's stderr.
        result = { ...raw, stderr: stripStraceDiagnostics(raw.stderr) };
      } catch (error) {
        // The command failed at the sandbox level; clean the trace and surface
        // the real error rather than running onFileChanges (which could mask it).
        removeTrace(traceFile);
        throw error;
      }
      // On abort the caller discards this command's changes; skip onFileChanges.
      if (execOptions?.signal?.aborted) {
        removeTrace(traceFile);
        return result;
      }
      // A throwing onFileChanges propagates here; the catcher one level up
      // (withBashExceptionCatch) turns a BashException into the tool result, or
      // fails the call for any other error.
      await collectCommand(traceFile);
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

// strace prints its own failures to stderr prefixed `strace: `. Anchor on that
// so a benign command whose output merely contains "Operation not permitted" or
// "not found" is not misclassified as a tracer failure.
const PTRACE_DENIED =
  /strace:[^\n]*(?:PTRACE_TRACEME|ptrace|Operation not permitted|EPERM)/i;
const STRACE_MISSING = /strace:?\s+(?:command\s+)?not found/i;

/**
 * One-time probe at sandbox setup. Runs a known create/write/rename sequence
 * under strace and asserts the trace is clean and parseable. Throws
 * {@link StraceUnavailableError} (hard-fail) when ptrace is blocked, strace is
 * absent, or the trace is garbled (e.g. amd64 under Rosetta).
 */
async function selfTestStrace(sandbox: DisposableSandbox): Promise<void> {
  const probeDir = `/tmp/dat-strace-${randomUUID()}`;
  const traceFile = `/tmp/dat-strace-${randomUUID()}.trace`;
  const q = shellQuote;
  const sequence =
    `mkdir -p ${q(probeDir)} && ` +
    `echo hi > ${q(`${probeDir}/a.txt`)} && ` +
    `mv ${q(`${probeDir}/a.txt`)} ${q(`${probeDir}/b.txt`)} && ` +
    `echo more > ${q(`${probeDir}/c.txt`)}`;
  const wrapped = buildStraceCommand(sequence, traceFile, '/tmp');

  let result: CommandResult | undefined;
  let raw = '';
  try {
    result = await sandbox.executeCommand(wrapped);
    raw = await sandbox.readFile(traceFile).catch(() => '');

    const diagnostics = `exit=${result.exitCode}\nstderr=${result.stderr}\ntrace[0:600]=${raw.slice(0, 600)}`;

    // Order matters: a ptrace block makes strace error on stderr AND emit no
    // trace, so check the ptrace signal (stderr only) before the empty-trace
    // strace-missing check, or a blocked ptrace would be mislabelled.
    if (PTRACE_DENIED.test(result.stderr)) {
      throw new StraceUnavailableError('ptrace-blocked', diagnostics);
    }
    if (!raw || result.exitCode === 127 || STRACE_MISSING.test(result.stderr)) {
      throw new StraceUnavailableError('strace-missing', diagnostics);
    }

    // Scope to the probe dir; the exact-path `traceFile` exclusion drops the
    // sibling trace file that lives under /tmp alongside it.
    const changes = parseStraceTrace(raw, {
      include: [probeDir, `${probeDir}/**`],
      traceFile,
    });
    const hasRealFdPath = raw.includes(`<${probeDir}/`);
    const hasRename = changes.some(
      (c) =>
        c.op === 'rename' &&
        c.from === `${probeDir}/a.txt` &&
        c.path === `${probeDir}/b.txt`,
    );
    const hasWrite = changes.some((c) => c.op === 'write');
    const allUnderDir = changes.every(
      (c) => c.path === probeDir || c.path.startsWith(`${probeDir}/`),
    );
    if (!hasRealFdPath || !hasRename || !hasWrite || !allUnderDir) {
      throw new StraceUnavailableError('trace-unparseable', diagnostics);
    }
  } finally {
    void sandbox
      .executeCommand(`rm -rf ${q(probeDir)} ${q(traceFile)}`)
      .catch(() => {});
  }
}
