import {
  type Experimental_SandboxDirectoryEntry,
  type Experimental_SandboxFileStat,
  type Experimental_SandboxProcess,
  type Experimental_SandboxRunOptions,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
  extractLines,
} from '@ai-sdk/provider-utils';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  ContainerErrorFactory,
  EngineContainer,
  EngineProcess,
  EngineProcessOptions,
} from './container-engine.ts';
import { shellQuote } from './shell-quote.ts';
import type { CommandResult, DisposableSandbox } from './types.ts';

// The scripts are copied from `vercel-sandbox-session.ts` of
// `@ai-sdk/sandbox-vercel`, which does not export them. Containers are Linux,
// so its BSD `stat` fallback is left out.

// Distinct from the exit codes bash and coreutils use for their own errors.
const NOT_FOUND_EXIT_CODE = 3;
const WRONG_TYPE_EXIT_CODE = 4;

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
  const [type, size] = stdout.split(' ');
  return {
    type: type as Experimental_SandboxFileStat['type'],
    size: Number(size),
  };
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
      return {
        name: record.slice(separator + 1),
        type: record.slice(
          0,
          separator,
        ) as Experimental_SandboxDirectoryEntry['type'],
      };
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
 * an exec. The wrapper writes the command's process group to `controlPath` for a
 * later exec to kill, and enforces `commandTimeout` itself.
 */
function managedCommand(
  command: string,
  controlPath: string,
  commandTimeout: number | undefined,
): string {
  return [
    'set -m',
    `control=${shellQuote(controlPath)}`,
    ': > "$control" || exit 1',
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
  controlPath: string,
  exitCode: Promise<number>,
): Promise<void> {
  const exited = exitCode.then(
    () => true,
    () => true,
  );
  const killGroup = [
    `IFS= read -r pid < ${shellQuote(controlPath)} || exit 0`,
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
      // Joined, not normalized, so that `link/..` follows the link.
      workingDirectory:
        workingDirectory === undefined || posix.isAbsolute(workingDirectory)
          ? workingDirectory
          : `${container.workdir}/${workingDirectory}`,
    };
  };

  const start = async (options: Experimental_SandboxSpawnOptions) => {
    const { command, abortSignal, stdin } = options;
    abortSignal?.throwIfAborted();
    const controlPath = `/dev/shm/deepagents-exec-${randomUUID()}.pid`;
    const process = await container.spawn(
      [
        'bash',
        '-c',
        managedCommand(command, controlPath, container.commandTimeout),
      ],
      { ...scope(options), stdin },
    );
    let termination: Promise<void> | undefined;
    const kill = () =>
      (termination ??= terminate(container, controlPath, process.exitCode));
    const onAbort = () => {
      // Observe transport failures immediately; `exitCode` still reports the
      // original rejection once the command's transport finishes.
      void kill().catch(() => {});
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });
    void process.exitCode
      .catch(() => {})
      .finally(() => abortSignal?.removeEventListener('abort', onAbort));
    return { process, kill };
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
    const { process, kill } = await start(options);
    return {
      stdout: process.stdout,
      stderr: process.stderr,
      ...(process.stdin ? { stdin: process.stdin } : {}),
      wait: async () => ({
        exitCode: await process.exitCode.finally(() =>
          options.abortSignal?.throwIfAborted(),
        ),
      }),
      kill,
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
      const { process } = await start(options);
      return collectOutput(process);
    },
    spawn,
    readBinaryFile,
    readFile: async (options) => {
      const bytes = await readBinaryFile(options);
      return bytes && ReadableStream.from([bytes]);
    },
    readTextFile: async ({ startLine, endLine, encoding, ...options }) => {
      const bytes = await readBinaryFile(options);
      if (!bytes) return null;
      return extractLines({
        text: Buffer.from(bytes).toString(encoding as BufferEncoding),
        startLine,
        endLine,
      });
    },
    writeBinaryFile,
    writeFile: async ({ content, ...options }) =>
      writeBinaryFile({
        ...options,
        content: await new Response(content).bytes(),
      }),
    writeTextFile: ({ content, encoding, ...options }) =>
      writeBinaryFile({
        ...options,
        content: Buffer.from(content, encoding as BufferEncoding),
      }),
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
