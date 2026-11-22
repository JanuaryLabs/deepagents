import {
  type Experimental_SandboxDirectoryEntry,
  type Experimental_SandboxFileStat,
  type Experimental_SandboxProcess,
  type Experimental_SandboxRunOptions,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
} from '@ai-sdk/provider-utils';
import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ChatEngineContainer,
  ContainerErrorFactory,
  EngineContainer,
  EngineProcess,
  EngineProcessOptions,
} from './container-engine.ts';
import {
  chatSandboxHandle,
  collect,
  controlProcess,
  resolveIn,
  textCalls,
} from './session.ts';
import { shellQuote } from './shell-quote.ts';
import type { ChatSandbox, CommandResult, DisposableSandbox } from './types.ts';

// The scripts are copied from `vercel-sandbox-session.ts` of
// `@ai-sdk/sandbox-vercel`, which does not export them. Containers are Linux,
// so its BSD `stat` fallback is left out.

// Distinct from the exit codes bash and coreutils use for their own errors.
const NOT_FOUND_EXIT_CODE = 3;
const WRONG_TYPE_EXIT_CODE = 4;

export const FILE_STAT_TYPES = [
  'file',
  'directory',
  'other',
] as const satisfies readonly Experimental_SandboxFileStat['type'][];

const DIRECTORY_ENTRY_TYPES = [
  'file',
  'directory',
  'symlink',
  'other',
] as const satisfies readonly Experimental_SandboxDirectoryEntry['type'][];

// `[ -e ]` is false both for missing paths and for paths that cannot be
// resolved (permissions, symbolic link loops), so open the path to get the
// reason. The error message ends with the reason; the path before it is
// user-supplied.
const EXIT_MISSING_FUNCTION = `
exit_missing() {
  error=$(LC_ALL=C; : 2>&1 < "$1")
  case $error in
    *": No such file or directory" | *": Not a directory") exit ${NOT_FOUND_EXIT_CODE} ;;
  esac
  echo "\${error:-Cannot access $1}" >&2
  exit 1
}
`;

const STAT_SCRIPT = `${EXIT_MISSING_FUNCTION}
[ -e "$1" ] || exit_missing "$1"
if [ -f "$1" ]; then type=file; elif [ -d "$1" ]; then type=directory; else type=other; fi
size=$(stat -L -c %s -- "$1") || exit 1
printf '%s %s' "$type" "$size"
`;

const READ_FILE_SCRIPT = `${EXIT_MISSING_FUNCTION}
[ -e "$1" ] || exit_missing "$1"
base64 < "$1"
`;

// `cd -P` so that `link/..` lists the same directory `[ -d ]` checked, and `./`
// so that `CDPATH` and a directory named `-` are not special. `nullglob` would
// list an unreadable directory as empty, so check `-r` first.
const LIST_DIRECTORY_SCRIPT = `${EXIT_MISSING_FUNCTION}
if [ ! -d "$1" ]; then
  [ -e "$1" ] || exit_missing "$1"
  echo "Not a directory" >&2
  exit ${WRONG_TYPE_EXIT_CODE}
fi
case $1 in /*) dir=$1 ;; *) dir=./$1 ;; esac
cd -P -- "$dir" || exit 1
[ -r . ] || { echo "Permission denied" >&2; exit 1; }
shopt -s dotglob nullglob
for name in *; do
  if [ -L "$name" ]; then type=symlink
  elif [ -f "$name" ]; then type=file
  elif [ -d "$name" ]; then type=directory
  else type=other
  fi
  printf '%s %s\\0' "$type" "$name"
done
`;

const DELETE_FILE_SCRIPT = `${EXIT_MISSING_FUNCTION}
if [ -d "$1" ] && [ ! -L "$1" ]; then
  echo "Is a directory" >&2
  exit ${WRONG_TYPE_EXIT_CODE}
fi
[ -e "$1" ] || [ -L "$1" ] || exit_missing "$1"
rm -f -- "$1"
`;

async function runPathScript(
  container: Pick<EngineContainer, 'exec'>,
  script: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const result = await container.exec(['bash', '-c', script, 'bash', path], {
    signal,
  });
  signal?.throwIfAborted();
  return result;
}

/** The stat of `path` through a command, for what no engine request reaches. */
export async function statOverExec(
  container: Pick<EngineContainer, 'exec'>,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Experimental_SandboxFileStat | null> {
  const { exitCode, stdout, stderr } = await runPathScript(
    container,
    STAT_SCRIPT,
    path,
    signal,
  );
  if (exitCode === NOT_FOUND_EXIT_CODE) return null;
  if (exitCode !== 0) {
    throw new Error(`Failed to stat "${path}": ${stderr.trim()}`);
  }
  const [printed, size] = stdout.split(' ');
  const type = FILE_STAT_TYPES.find((known) => known === printed);
  if (!type) {
    throw new Error(`Failed to stat "${path}": unknown type "${printed}"`);
  }
  return { type, size: Number(size) };
}

/** The bytes of `path` through a command, for what no engine request reaches. */
export async function readFileOverExec(
  container: Pick<EngineContainer, 'exec'>,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
  const { exitCode, stdout, stderr } = await runPathScript(
    container,
    READ_FILE_SCRIPT,
    path,
    signal,
  );
  if (exitCode === NOT_FOUND_EXIT_CODE) return null;
  if (exitCode !== 0) {
    throw new Error(`Failed to read file "${path}": ${stderr.trim()}`);
  }
  return Buffer.from(stdout, 'base64');
}

/** Writes `path` through a command, for what no engine request reaches. */
export async function writeFileOverExec(
  container: Pick<EngineContainer, 'exec'>,
  path: string,
  content: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<void> {
  const { exitCode, stderr } = await container.exec(
    [
      'bash',
      '-c',
      'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
      'bash',
      path,
    ],
    { signal, stdin: content },
  );
  signal?.throwIfAborted();
  if (exitCode !== 0) {
    throw new Error(`Failed to write file "${path}": ${stderr.trim()}`);
  }
}

async function listDirectoryOverExec(
  container: EngineContainer,
  path: string,
  signal: AbortSignal | undefined,
): Promise<Experimental_SandboxDirectoryEntry[] | null> {
  const { exitCode, stdout, stderr } = await runPathScript(
    container,
    LIST_DIRECTORY_SCRIPT,
    path,
    signal,
  );
  if (exitCode === NOT_FOUND_EXIT_CODE) return null;
  if (exitCode !== 0) {
    throw new Error(`Failed to list "${path}": ${stderr.trim()}`);
  }
  return stdout
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const separator = record.indexOf(' ');
      const printed = record.slice(0, separator);
      const type = DIRECTORY_ENTRY_TYPES.find((known) => known === printed);
      if (!type) {
        throw new Error(`Failed to list "${path}": unknown type "${printed}"`);
      }
      return { name: record.slice(separator + 1), type };
    });
}

async function deleteFileOverExec(
  container: EngineContainer,
  path: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const { exitCode, stderr } = await runPathScript(
    container,
    DELETE_FILE_SCRIPT,
    path,
    signal,
  );
  if (exitCode === NOT_FOUND_EXIT_CODE) return false;
  if (exitCode === WRONG_TYPE_EXIT_CODE) {
    throw new Error(`Cannot delete "${path}": it is a directory.`);
  }
  if (exitCode !== 0) {
    throw new Error(`Failed to delete "${path}": ${stderr.trim()}`);
  }
  return true;
}

/**
 * Where a managed command keeps its kill-control file, in order. `/dev/shm` is
 * missing with Compose `ipc: none`; `/tmp` is read-only on a read-only rootfs.
 */
const CONTROL_DIRECTORIES = ['/dev/shm', '/tmp'];

/** Reads a process to its end. */
export async function collectOutput(
  process: EngineProcess,
): Promise<CommandResult> {
  const [stdout, stderr, exitCode] = await Promise.all([
    text(process.stdout),
    text(process.stderr),
    process.exitCode,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Wraps `command` so the sandbox can stop it: no engine has a request that stops
 * an exec. The wrapper writes the command's process group to `controlFile` in the
 * first writable directory of {@link CONTROL_DIRECTORIES} for a later exec to
 * kill, and enforces `commandTimeout` itself. When no directory is writable, the
 * command does not run.
 */
function managedCommand(
  command: string,
  controlFile: string,
  commandTimeout: number | undefined,
): string {
  return [
    'set -m',
    'control=',
    `for dir in ${CONTROL_DIRECTORIES.join(' ')}; do`,
    `  if { : > "$dir/"${shellQuote(controlFile)}; } 2>/dev/null; then control="$dir/"${shellQuote(controlFile)}; break; fi`,
    'done',
    `[ -n "$control" ] || { echo ${shellQuote(`Cannot start the command: neither ${CONTROL_DIRECTORIES.join(' nor ')} is writable for the file that lets the sandbox stop it`)} >&2; exit 1; }`,
    'timer=',
    'trap \'if [ -n "$timer" ]; then kill -TERM "$timer" 2>/dev/null || :; wait "$timer" 2>/dev/null || :; fi; rm -f "$control" "$control.timeout"\' EXIT',
    `bash -lc ${shellQuote(command)} &`,
    'pid=$!',
    'printf \'%s\\n\' "$pid" > "$control"',
    ...(commandTimeout
      ? [
          // Keep the deadline on the engine host: SSH setup/round trips must not
          // let the command run past its execution budget.
          '(',
          `sleep ${commandTimeout / 1000} &`,
          'alarm=$!',
          'trap \'kill "$alarm" 2>/dev/null || :; wait "$alarm" 2>/dev/null || :; exit 0\' TERM',
          'wait "$alarm" || exit',
          'if kill -0 -- "-$pid" 2>/dev/null; then : > "$control.timeout"; kill -KILL -- "-$pid" 2>/dev/null || :; fi',
          ') &',
          'timer=$!',
        ]
      : []),
    'wait "$pid"',
    'status=$?',
    '[ ! -e "$control.timeout" ] || exit 124',
    'exit "$status"',
  ].join('\n');
}

/**
 * Kills the managed command's process group and waits until it is gone. One exec
 * reads the group and kills it, so a stop costs one round trip on a remote
 * engine. The group is not written yet right after the start: until the exit,
 * try again.
 */
async function terminate(
  container: EngineContainer,
  controlFile: string,
  exitCode: Promise<number>,
): Promise<void> {
  const exited = exitCode.then(
    () => true,
    () => true,
  );
  const killGroup = [
    `for dir in ${CONTROL_DIRECTORIES.join(' ')}; do`,
    `  { IFS= read -r pid < "$dir/"${shellQuote(controlFile)}; } 2>/dev/null && break`,
    '  pid=',
    'done',
    '[ -n "$pid" ] || exit 0',
    'printf found',
    'kill -KILL -- "-$pid" 2>/dev/null || exit 0',
    'group_alive() {',
    '  local stat rest state pgrp',
    '  for stat_path in /proc/[0-9]*/stat; do',
    '    IFS= read -r stat < "$stat_path" || continue',
    '    rest=${stat##*) }',
    '    read -r state _ pgrp _ <<< "$rest"',
    '    if [ "$pgrp" = "$pid" ] && [ "$state" != Z ]; then return 0; fi',
    '  done',
    '  return 1',
    '}',
    'while group_alive; do sleep 0.01; done',
  ].join('\n');

  while (true) {
    const { stdout } = await container.exec(['bash', '-c', killGroup]);
    if (stdout) return;
    if (await Promise.race([exited, delay(10).then(() => false)])) return;
  }
}

export function validateEnv(
  env: Record<string, string> | undefined,
  errors: ContainerErrorFactory,
): void {
  for (const key of Object.keys(env ?? {})) {
    if (key.length === 0 || key.includes('=')) {
      throw errors.generic(`Invalid environment variable key: "${key}"`);
    }
  }
}

/**
 * The AI SDK sandbox session of a running container, over what the engine
 * gives. Disposal is added by the strategy that owns the container.
 */
export function containerSession(
  container: EngineContainer,
  errors: ContainerErrorFactory,
): Omit<DisposableSandbox, 'dispose' | typeof Symbol.asyncDispose> {
  const scope = ({
    workingDirectory,
    env,
  }: Experimental_SandboxRunOptions): EngineProcessOptions => {
    validateEnv(env, errors);
    return {
      env,
      workingDirectory:
        workingDirectory === undefined
          ? undefined
          : resolveIn(container.workdir, workingDirectory),
    };
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
    options: Experimental_SandboxSpawnOptions,
  ): Promise<
    Experimental_SandboxProcess | Experimental_WritableSandboxProcess
  > {
    const { command, abortSignal, stdin } = options;
    abortSignal?.throwIfAborted();
    const controlFile = `deepagents-exec-${randomUUID()}.pid`;
    const process = await container.spawn(
      [
        'bash',
        '-c',
        managedCommand(command, controlFile, container.commandTimeout),
      ],
      { ...scope(options), stdin },
    );
    const control = controlProcess({
      exitCode: process.exitCode,
      kill: () => terminate(container, controlFile, process.exitCode),
      abortSignal,
    });
    return {
      stdout: process.stdout,
      stderr: process.stderr,
      ...(process.stdin ? { stdin: process.stdin } : {}),
      ...control,
    };
  }

  const readBinaryFile: DisposableSandbox['readBinaryFile'] = async ({
    path,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    return container.readFile(path, abortSignal);
  };

  const writeBinaryFile: DisposableSandbox['writeBinaryFile'] = async ({
    path,
    content,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    return container.writeFile(path, content, abortSignal);
  };

  return {
    description: `Commands run through bash -lc in a Linux container, starting in ${container.workdir}.`,
    run: async (options) => {
      const { command, abortSignal } = options;
      abortSignal?.throwIfAborted();
      if (!abortSignal && !container.commandTimeout) {
        return container.exec(['bash', '-lc', command], scope(options));
      }
      return collect(await spawn(options));
    },
    spawn,
    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      return bytes && ReadableStream.from([bytes]);
    },
    writeBinaryFile,
    writeFile: async ({ content, ...options }) =>
      writeBinaryFile({
        ...options,
        content: await new Response(content).bytes(),
      }),
    ...textCalls({ readBinaryFile, writeBinaryFile }),
    stat: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      return container.stat(path, abortSignal);
    },
    listDirectory: ({ path, abortSignal }) =>
      listDirectoryOverExec(container, path, abortSignal),
    deleteFile: ({ path, abortSignal }) =>
      deleteFileOverExec(container, path, abortSignal),
  };
}

/**
 * The handle of a chat's container: its session, `resume`, and a `close` that
 * runs `release` once and never touches the container. Once the container is
 * gone or replaced, its own calls, or its `assertCurrent` before each
 * operation, reject with `SandboxNotFoundError`.
 */
export function chatContainerSandbox(
  container: ChatEngineContainer,
  errors: ContainerErrorFactory,
  chatId: string,
  release: () => Promise<void>,
): ChatSandbox {
  return chatSandboxHandle(chatId, containerSession(container, errors), {
    resume: () => container.resume(),
    release,
    assertCurrent: container.assertCurrent?.bind(container),
  });
}
