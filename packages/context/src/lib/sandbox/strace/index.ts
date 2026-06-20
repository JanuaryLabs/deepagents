import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { shellQuote } from '../shell-quote.ts';
import type { FileChange } from './file-change.ts';

export type { FileChange, FileChangeOp } from './file-change.ts';

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
export function buildStraceCommand(
  command: string,
  traceFile: string,
  traceDir: string,
): string {
  return (
    `mkdir -p ${shellQuote(traceDir)} 2>/dev/null; ` +
    `strace ${STRACE_FLAGS} -o ${shellQuote(traceFile)} -- sh -c ${shellQuote(command)}`
  );
}

/**
 * Like {@link buildStraceCommand}, but dumps the (base64) trace inline on stdout
 * after `sentinel`, then exits with the traced command's code. This lets one
 * `executeCommand` round-trip carry both the command output and its trace — no
 * second `readFile` exec to pull the trace out of the container. Pair with
 * {@link splitTracedOutput}. `sentinel` must be unguessable (a UUID) so the
 * command's own stdout cannot contain it. `base64` keeps the trace stream-safe
 * and its stderr is dropped so a missing trace (strace failed) doesn't leak into
 * the command's stderr.
 */
export function buildTracedCommand(
  command: string,
  traceFile: string,
  traceDir: string,
  sentinel: string,
): string {
  return (
    `mkdir -p ${shellQuote(traceDir)} 2>/dev/null; ` +
    `strace ${STRACE_FLAGS} -o ${shellQuote(traceFile)} -- sh -c ${shellQuote(command)}; ` +
    `__dat_rc=$?; ` +
    `printf '\\n%s\\n' ${shellQuote(sentinel)}; ` +
    `base64 ${shellQuote(traceFile)} 2>/dev/null; ` +
    `rm -f ${shellQuote(traceFile)} 2>/dev/null; ` +
    `exit $__dat_rc`
  );
}

/**
 * Split {@link buildTracedCommand} output into the command's own stdout and its
 * decoded strace trace. A missing sentinel (strace produced nothing) yields an
 * empty trace so the caller degrades to "no changes".
 */
export function splitTracedOutput(
  stdout: string,
  sentinel: string,
): { stdout: string; trace: string } {
  const marker = `\n${sentinel}\n`;
  const at = stdout.indexOf(marker);
  if (at === -1) return { stdout, trace: '' };
  const base64 = stdout.slice(at + marker.length);
  return {
    stdout: stdout.slice(0, at),
    trace: base64 ? Buffer.from(base64, 'base64').toString('utf8') : '',
  };
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

export interface ParseStraceOptions {
  include: string[];
  exclude?: string[];
  traceFile?: string;
  traceDir?: string;
}

/** A path is tracked when it matches an `include` glob and no `exclude` glob. */
export function matchesGlobs(
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
export function parseStraceTrace(
  raw: string,
  options: ParseStraceOptions,
): FileChange[] {
  const { include, exclude, traceDir, traceFile } = options;
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
  tail.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  changes.push(...tail);
  return changes;
}

// strace prints its own failures to stderr prefixed `strace: `. Anchor on that
// so a benign command whose output merely contains "Operation not permitted" or
// "not found" is not misclassified as a tracer failure.
const PTRACE_DENIED =
  /strace:[^\n]*(?:PTRACE_TRACEME|ptrace|Operation not permitted|EPERM)/i;
const STRACE_MISSING = /strace:?\s+(?:command\s+)?not found/i;

/**
 * The minimal structural surface {@link selfTestStrace} needs from its host.
 * Deliberately narrower than `DisposableSandbox` so the probe can run anywhere:
 * a remote/docker caller passes its sandbox unchanged (it satisfies this shape
 * structurally), and an in-process caller (e.g. a daemon running as PID 1
 * inside the container) implements just these two methods over
 * `node:child_process` + `node:fs`.
 */
export interface StraceHost {
  executeCommand(
    command: string,
  ): Promise<{ exitCode: number; stderr: string }>;
  readFile(path: string): Promise<string>;
}

/**
 * One-time probe at sandbox setup. Runs a known create/write/rename sequence
 * under strace and asserts the trace is clean and parseable. Throws
 * {@link StraceUnavailableError} (hard-fail) when ptrace is blocked, strace is
 * absent, or the trace is garbled (e.g. amd64 under Rosetta).
 *
 * "strace works in this sandbox" is an invariant of the (image + host kernel +
 * seccomp/caps) — constant across every tool call and chat turn in a given
 * container — so this is the consumer's once-per-container responsibility (e.g.
 * a daemon boot gate), NOT a per-tool cost. `createBashTool` /
 * `withStraceFileChanges` no longer call it.
 */
export async function selfTestStrace(host: StraceHost): Promise<void> {
  const probeDir = `/tmp/dat-strace-${randomUUID()}`;
  const traceFile = `/tmp/dat-strace-${randomUUID()}.trace`;
  const q = shellQuote;
  const sequence =
    `mkdir -p ${q(probeDir)} && ` +
    `echo hi > ${q(`${probeDir}/a.txt`)} && ` +
    `mv ${q(`${probeDir}/a.txt`)} ${q(`${probeDir}/b.txt`)} && ` +
    `echo more > ${q(`${probeDir}/c.txt`)}`;
  const wrapped = buildStraceCommand(sequence, traceFile, '/tmp');

  let result: { exitCode: number; stderr: string } | undefined;
  let raw = '';
  try {
    result = await host.executeCommand(wrapped);
    raw = await host.readFile(traceFile).catch(() => '');

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
    void host
      .executeCommand(`rm -rf ${q(probeDir)} ${q(traceFile)}`)
      .catch(() => {});
  }
}
