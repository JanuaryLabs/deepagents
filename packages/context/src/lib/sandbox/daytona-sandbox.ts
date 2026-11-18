import {
  type Experimental_SandboxDirectoryEntry,
  type Experimental_SandboxProcess,
  type Experimental_SandboxRunOptions,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
} from '@ai-sdk/provider-utils';
import type { DaytonaV2Client } from '@daytona/sdk';
import type {
  CreateSandboxOptions,
  ProcessStartOptions,
  Sandbox,
  WaitResult,
} from '@daytona/sdk/v2';
import { constants } from 'node:os';
import { setTimeout } from 'node:timers/promises';

import { statOverExec } from './container-session.ts';
import {
  collect,
  controlProcess,
  createByteReadable,
  resolveIn,
  textCalls,
} from './session.ts';
import type { DisposableSandbox, SandboxReadinessOptions } from './types.ts';

const COMMAND_TIMEOUT_EXIT_CODE = 124;
const TIMED_OUT_MESSAGE = 'Command timed out';
const SIGNAL_NUMBERS = new Map(Object.entries(constants.signals));

// A path under a file fails as a bad request, not as a missing file.
const NOT_A_DIRECTORY = /\(os error 20\)$/;
// A write onto a directory fails as "File exists" (EEXIST), not as EISDIR.
const ALREADY_EXISTS = /\(os error 17\)$/;
// A new sandbox reports `started` a moment before its process gateway takes
// calls; a call in that window fails as "bad gateway: sandbox … not available".
const GATEWAY_NOT_READY = /not available/;
const GATEWAY_ATTEMPTS = 10;
const GATEWAY_RETRY_MS = 500;

type DaytonaSdk = typeof import('@daytona/sdk/v2');

/**
 * Creates a sandbox. With a `name`, a second create with the same name and
 * options returns the sandbox the first one made, so the name is a
 * get-or-create key; the same name with other options is a conflict.
 */
type DaytonaCreateOptions = Omit<
  CreateSandboxOptions,
  'autoDelete' | 'idempotencyKey'
> & {
  sandboxId?: never;
  /** A registered image name or `img_…` id. Default: the organization's default Linux image. */
  image?: string;
};

/** Attaches to a sandbox that exists. */
interface DaytonaAttachOptions {
  sandboxId: string;
}

type DaytonaTarget = DaytonaCreateOptions | DaytonaAttachOptions;

export type DaytonaSandboxOptions = SandboxReadinessOptions & {
  /**
   * Per-command timeout in milliseconds for `run` and `spawn`; the command
   * then exits 124. Daytona's deadline counts whole seconds, so it is rounded
   * up to the next second.
   */
  commandTimeout?: number;
} & DaytonaTarget;

/** How every command runs, for both a buffered `run` and a started process. */
type CommandScope = Pick<
  ProcessStartOptions,
  'shell' | 'login' | 'cwd' | 'env' | 'executionTimeoutSeconds'
>;

export class DaytonaSandboxError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'DaytonaSandboxError';
    this.cause = cause;
  }
}

export class DaytonaCreationError extends DaytonaSandboxError {
  constructor(message: string, cause?: Error) {
    super(`Failed to create Daytona sandbox: ${message}`, cause);
    this.name = 'DaytonaCreationError';
  }
}

/**
 * Creates a sandbox backed by a Daytona v2 sandbox.
 *
 * `dispose()` deletes a sandbox this call created and leaves one it attached
 * to, by `sandboxId` or by a `name` that already had a sandbox. A Linux
 * Daytona sandbox has no stopped state, so delete is its only release.
 *
 * Requires the optional peer dependency `@daytona/sdk`.
 *
 * @example
 * ```typescript
 * const daytona = new Daytona();
 * await using sandbox = await createDaytonaSandbox(daytona.v2, { name: chatId });
 * const result = await sandbox.run({ command: 'echo hello' });
 * ```
 */
export async function createDaytonaSandbox(
  client: DaytonaV2Client,
  options: DaytonaSandboxOptions = {},
): Promise<DisposableSandbox> {
  const { commandTimeout, readiness, ...target } = options;
  const sdk = await import('@daytona/sdk/v2');
  const { sandbox, created } = await acquire(client, target);

  let session: DisposableSandbox;
  try {
    session = daytonaSession({
      sdk,
      sandbox,
      created,
      workdir: await startingDirectory(sdk, sandbox),
      commandTimeout,
    });
  } catch (error) {
    if (created) await sandbox.delete();
    throw error;
  }

  if (readiness) {
    try {
      await readiness(session);
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }
  return session;
}

async function acquire(
  client: DaytonaV2Client,
  target: DaytonaTarget,
): Promise<{ sandbox: Sandbox; created: boolean }> {
  if (target.sandboxId !== undefined) {
    return { sandbox: await client.get(target.sandboxId), created: false };
  }
  const { image, ...create } = target;
  const sandbox = await client.create(image, create);
  // Only the create that made the sandbox receives an access token; a create
  // that returned the sandbox of an earlier one with the same name does not.
  return { sandbox, created: sandbox.accessToken !== undefined };
}

/** The directory commands start in, which also proves Bash runs. */
async function startingDirectory(
  sdk: DaytonaSdk,
  sandbox: Sandbox,
): Promise<string> {
  try {
    const result = await whenGatewayReady(sdk, () =>
      sandbox.process.run('printf %s "$PWD"', { shell: 'bash', login: true }),
    );
    if (result.reason === 'exited' && result.exitCode === 0) {
      return result.stdout;
    }
    throw new Error(result.stderr || result.reason);
  } catch (error) {
    const err = toError(error);
    throw new DaytonaCreationError(
      `Bash is required to execute sandbox commands but could not be started: ${err.message}`,
      err,
    );
  }
}

async function whenGatewayReady<T>(
  sdk: DaytonaSdk,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const notReady =
        error instanceof sdk.InternalServerError &&
        GATEWAY_NOT_READY.test(error.message);
      if (!notReady || attempt === GATEWAY_ATTEMPTS) throw error;
      await setTimeout(GATEWAY_RETRY_MS);
    }
  }
}

function exitCodeOf(result: WaitResult): number {
  switch (result.reason) {
    case 'exited':
      if (result.exitCode !== undefined) return result.exitCode;
      break;
    case 'signaled': {
      const number = SIGNAL_NUMBERS.get(`SIG${result.signal}`);
      if (number !== undefined) return 128 + number;
      break;
    }
    case 'timed_out':
      return COMMAND_TIMEOUT_EXIT_CODE;
    case 'lost':
    case 'failed':
    case 'unknown':
      break;
  }
  throw new DaytonaSandboxError(
    `The command ended without an exit code: ${result.rawReason ?? result.reason}`,
  );
}

function entryType(mode: string): Experimental_SandboxDirectoryEntry['type'] {
  switch (mode[0]) {
    case '-':
      return 'file';
    case 'd':
      return 'directory';
    case 'L':
      return 'symlink';
    default:
      return 'other';
  }
}

/**
 * The AI SDK sandbox session of a Daytona sandbox. File calls use the SDK's
 * filesystem; commands run as SDK processes, which give byte-exact output,
 * stdin, a kill and an exit result.
 */
function daytonaSession(args: {
  sdk: DaytonaSdk;
  sandbox: Sandbox;
  created: boolean;
  workdir: string;
  commandTimeout?: number;
}): DisposableSandbox {
  const { sdk, sandbox, created, workdir, commandTimeout } = args;

  // The SDK takes absolute paths and an absolute `cwd` only.
  const resolve = (path: string) => resolveIn(workdir, path);

  const processOptions = ({
    workingDirectory,
    env,
  }: Experimental_SandboxRunOptions): CommandScope => ({
    shell: 'bash',
    login: true,
    cwd: workingDirectory === undefined ? workdir : resolve(workingDirectory),
    ...(env ? { env } : {}),
    ...(commandTimeout
      ? { executionTimeoutSeconds: Math.ceil(commandTimeout / 1000) }
      : {}),
  });

  const isMissing = (error: unknown) =>
    error instanceof sdk.FileNotFoundError ||
    (error instanceof sdk.BadRequestError &&
      NOT_A_DIRECTORY.test(error.message));

  const orNull = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      return await operation();
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const execRunner = {
    exec: async (argv: string[]) => {
      const result = await sandbox.process.run({ argv });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: exitCodeOf(result),
      };
    },
  };

  const stat: DisposableSandbox['stat'] = async ({ path, abortSignal }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    const info = await orNull(() => sandbox.fs.stat(target));
    if (!info) return null;
    const type = entryType(info.mode);
    // The SDK describes a link itself; the contract follows it.
    if (type === 'symlink')
      return statOverExec(execRunner, target, abortSignal);
    return { type, size: info.size };
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
    const handle = await sandbox.process.start(command, {
      ...processOptions(options),
      stdin: stdin ? 'open' : 'closed',
    });

    const stdout = createByteReadable();
    const stderr = createByteReadable();
    const pump = async () => {
      for await (const event of handle.streamLogs({ encoding: 'base64' })) {
        if (event.type !== 'log') continue;
        const bytes = Buffer.from(event.frame.data, 'base64');
        if (event.frame.channel === 'stdout') stdout.enqueue(bytes);
        else if (event.frame.channel === 'stderr') stderr.enqueue(bytes);
      }
    };
    const exitCode = Promise.all([handle.wait(), pump()])
      .then(([result]) => {
        if (result.reason === 'timed_out') {
          stderr.enqueue(new TextEncoder().encode(TIMED_OUT_MESSAGE));
        }
        return exitCodeOf(result);
      })
      .then(
        (code) => {
          stdout.close();
          stderr.close();
          return code;
        },
        (error: unknown) => {
          const err = toError(error);
          stdout.error(err);
          stderr.error(err);
          throw err;
        },
      );
    exitCode.catch(() => {});

    const control = controlProcess({
      exitCode,
      kill: () =>
        handle.kill().catch((error: unknown) => {
          // A kill after the exit, or racing it, finds the process gone.
          if (!(error instanceof sdk.ProcessTerminalError)) throw error;
        }),
      abortSignal,
    });

    return {
      stdout: stdout.stream,
      stderr: stderr.stream,
      ...(stdin
        ? {
            stdin: new WritableStream<Uint8Array>({
              write: (chunk) => handle.writeStdin(chunk),
              close: () => handle.closeStdin(),
              abort: () => handle.closeStdin(),
            }),
          }
        : {}),
      ...control,
    };
  }

  const readBinaryFile: DisposableSandbox['readBinaryFile'] = async ({
    path,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    return orNull(() => sandbox.fs.readBytes(resolve(path)));
  };

  const writeBinaryFile: DisposableSandbox['writeBinaryFile'] = async ({
    path,
    content,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    try {
      await sandbox.fs.writeBytes(target, content);
    } catch (error) {
      if (
        error instanceof sdk.BadRequestError &&
        ALREADY_EXISTS.test(error.message) &&
        (await stat({ path: target }))?.type === 'directory'
      ) {
        throw new Error(`Cannot write "${path}": it is a directory.`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  let disposing: Promise<void> | undefined;
  const dispose = () =>
    (disposing ??= created ? sandbox.delete() : Promise.resolve());

  return {
    description: `Commands run through bash -lc in a Daytona sandbox, starting in ${workdir}.`,
    run: async (options) => {
      const { command, abortSignal } = options;
      abortSignal?.throwIfAborted();
      if (abortSignal) return collect(await spawn(options));
      const result = await sandbox.process.run(
        command,
        processOptions(options),
      );
      return {
        stdout: result.stdout,
        stderr:
          result.reason === 'timed_out'
            ? `${result.stderr}${TIMED_OUT_MESSAGE}`
            : result.stderr,
        exitCode: exitCodeOf(result),
      };
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
    stat,
    listDirectory: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const target = resolve(path);
      try {
        const { items } = await sandbox.fs.list(target);
        return items.map((info) => ({
          name: info.name,
          type: entryType(info.mode),
        }));
      } catch (error) {
        // A file and a path under a file both fail as "Not a directory"; only
        // the file exists.
        if (!isMissing(error) || (await stat({ path: target }))) throw error;
        return null;
      }
    },
    deleteFile: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      try {
        await sandbox.fs.remove(resolve(path));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

function toError(error: unknown): Error {
  return Error.isError(error) ? error : new Error(String(error));
}
