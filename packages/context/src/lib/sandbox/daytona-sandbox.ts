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
  chatSandboxHandle,
  chatSandboxLabels,
  chatSandboxName,
  collect,
  controlProcess,
  createByteReadable,
  guardSession,
  resolveIn,
  textCalls,
} from './session.ts';
import {
  type ChatSandbox,
  type DisposableSandbox,
  type SandboxContext,
  type SandboxEnvironment,
  SandboxNotFoundError,
  type SandboxReadinessOptions,
  type SandboxSession,
} from './types.ts';

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

/** The SDK's create options that apply to every sandbox, one-off or a chat's. */
type DaytonaCreateOptions = Omit<
  CreateSandboxOptions,
  'name' | 'autoDelete' | 'idempotencyKey'
> & {
  /** A registered image name or `img_…` id. Default: the organization's default Linux image. */
  image?: string;
  /**
   * Per-command timeout in milliseconds for `run` and `spawn`; the command
   * then exits 124. Daytona's deadline counts whole seconds, so it is rounded
   * up to the next second.
   */
  commandTimeout?: number;
};

export type DaytonaSandboxOptions = SandboxReadinessOptions &
  DaytonaCreateOptions;

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
 * A one-off: it always creates its own sandbox, under a name Daytona
 * generates, and `dispose` deletes it; afterwards every operation rejects. A
 * sandbox that outlives the process, so that a chat's next turn finds its
 * files, is a chat's, through {@link DaytonaSandboxEnvironment}.
 *
 * Requires the optional peer dependency `@daytona/sdk`.
 *
 * @example
 * ```typescript
 * const daytona = new Daytona();
 * await using sandbox = await createDaytonaSandbox(daytona.v2);
 * const result = await sandbox.run({ command: 'echo hello' });
 * ```
 */
export async function createDaytonaSandbox(
  client: DaytonaV2Client,
  options: DaytonaSandboxOptions = {},
): Promise<DisposableSandbox> {
  const { commandTimeout, readiness, image, ...create } = options;
  const sdk = await import('@daytona/sdk/v2');
  const sandbox = await client.create(image, create);

  let workdir: string;
  try {
    workdir = await startingDirectory(sdk, sandbox);
  } catch (error) {
    await sandbox.delete();
    throw error;
  }
  const { session, release } = guardSession(
    daytonaSession({ sdk, sandbox, workdir, commandTimeout }),
    {
      release: () => sandbox.delete(),
      releasedMessage: `The sandbox "${sandbox.id}" is disposed.`,
    },
  );
  const disposable: DisposableSandbox = Object.assign(session, {
    dispose: release,
    [Symbol.asyncDispose]: release,
  });

  if (readiness) {
    try {
      await readiness(disposable);
    } catch (error) {
      await disposable.dispose();
      throw error;
    }
  }
  return disposable;
}

/**
 * No `volumes`: a chat's volumes depend on the chat, and the environment takes
 * them as `(chat) => …` only once a consumer needs Daytona volumes.
 */
export type DaytonaSandboxEnvironmentOptions = SandboxReadinessOptions &
  Omit<DaytonaCreateOptions, 'volumes'> & {
    /**
     * With a chat's id, names that chat's sandbox. Two environments with the
     * same namespace on one Daytona project reach the same sandboxes; give
     * each app or deployment its own.
     */
    namespace: string;
  };

/**
 * Chat sandboxes on Daytona v2. A chat's sandbox is named from the namespace
 * and the chat's id, and carries the labels `deepagents.sandbox.namespace` and
 * `deepagents.sandbox.chat` beside the caller's. `open` is Daytona's own
 * get-or-create by name; the create options apply only when it creates the
 * sandbox, and an existing one keeps the configuration it was created with.
 *
 * A Linux Daytona sandbox has no stopped state, so this environment has no
 * `stop`: bound idle cost with the create option `lifecyclePolicy`, such as
 * `{ idleExpirySeconds, onIdleTimeout: 'delete' }`. `delete` finds the
 * sandbox by name through Daytona search, which lags a create by a few
 * seconds: a `delete` in that window misses a sandbox just created. A handle
 * holds nothing but the HTTP client, so `close` releases nothing and never
 * deletes the sandbox.
 */
export class DaytonaSandboxEnvironment implements SandboxEnvironment {
  readonly #client: DaytonaV2Client;
  readonly #options: DaytonaSandboxEnvironmentOptions;

  constructor(
    client: DaytonaV2Client,
    options: DaytonaSandboxEnvironmentOptions,
  ) {
    this.#client = client;
    this.#options = options;
  }

  #name(chat: SandboxContext): string {
    return chatSandboxName(this.#options.namespace, chat);
  }

  async open(chat: SandboxContext): Promise<ChatSandbox> {
    const { namespace, commandTimeout, readiness, image, ...create } =
      this.#options;
    const sdk = await import('@daytona/sdk/v2');
    const name = this.#name(chat);
    let sandbox: Sandbox;
    try {
      sandbox = await this.#client.create(image, {
        ...create,
        name,
        labels: { ...create.labels, ...chatSandboxLabels(namespace, chat) },
      });
    } catch (error) {
      // The API's conflict for a name created with other options, as after a
      // deploy changed them: the existing sandbox keeps its configuration.
      if (
        !(error instanceof sdk.ConflictError) ||
        error.code !== 'CONFLICT' ||
        error.source !== 'DAYTONA_API'
      ) {
        throw error;
      }
      const [existing] = await this.#client.findByName(name);
      if (!existing) throw error;
      sandbox = existing;
    }

    const handle = chatSandboxHandle(
      chat.chatId,
      daytonaSession({
        sdk,
        sandbox,
        workdir: await startingDirectory(sdk, sandbox),
        commandTimeout,
      }),
      {
        resume: () => assertExists(sdk, sandbox),
        release: async () => {},
      },
    );
    if (readiness) {
      try {
        await readiness(handle);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return handle;
  }

  async delete(chat: SandboxContext): Promise<void> {
    const found = await this.#client.findByName(this.#name(chat));
    await Promise.all(found.map((sandbox) => this.#client.delete(sandbox)));
  }
}

/**
 * Rejects with `SandboxNotFoundError` when the sandbox is deleted, or being
 * deleted. A deleted sandbox reads as `destroyed` for a while, then as not
 * found.
 */
async function assertExists(
  sdk: DaytonaSdk,
  sandbox: Sandbox,
  failure?: unknown,
): Promise<void> {
  const gone = (cause: unknown) =>
    new SandboxNotFoundError(sandbox.id, cause === undefined ? {} : { cause });
  try {
    await sandbox.refreshData();
  } catch (error) {
    if (error instanceof sdk.NotFoundError) throw gone(failure ?? error);
    throw error;
  }
  if (sandbox.state === 'destroying' || sandbox.state === 'destroyed') {
    throw gone(failure);
  }
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
  workdir: string;
  commandTimeout?: number;
}): SandboxSession {
  const { sdk, sandbox, workdir, commandTimeout } = args;

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

  // A deleted sandbox fails a call as not found, or, when the call must first
  // get an access token, as a conflict; a read of its state tells it from a
  // call that failed in a live sandbox.
  const reach = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof sdk.DaytonaError && !isMissing(error)) {
        await assertExists(sdk, sandbox, error);
      }
      throw error;
    }
  };

  const orNull = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      return await reach(operation);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const execRunner = {
    exec: async (argv: string[]) => {
      const result = await reach(() => sandbox.process.run({ argv }));
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: exitCodeOf(result),
      };
    },
  };

  const stat: SandboxSession['stat'] = async ({ path, abortSignal }) => {
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
    const handle = await reach(() =>
      sandbox.process.start(command, {
        ...processOptions(options),
        stdin: stdin ? 'open' : 'closed',
      }),
    );

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
    const exitCode = Promise.all([reach(() => handle.wait()), reach(pump)])
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

  const readBinaryFile: SandboxSession['readBinaryFile'] = async ({
    path,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    try {
      return await orNull(() => sandbox.fs.readBytes(target));
    } catch (error) {
      if (await failedOnDirectory(error, target)) {
        throw new Error(`Cannot read "${path}": it is a directory.`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  // The current toolbox refuses a directory on a read or a write with
  // InvalidFilePathError "not a regular file"; ALREADY_EXISTS is the earlier
  // server's answer to a write.
  const failedOnDirectory = async (error: unknown, target: string) =>
    (error instanceof sdk.InvalidFilePathError ||
      (error instanceof sdk.BadRequestError &&
        ALREADY_EXISTS.test(error.message))) &&
    (await stat({ path: target }))?.type === 'directory';

  const writeBinaryFile: SandboxSession['writeBinaryFile'] = async ({
    path,
    content,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    try {
      await reach(() => sandbox.fs.writeBytes(target, content));
    } catch (error) {
      if (await failedOnDirectory(error, target)) {
        throw new Error(`Cannot write "${path}": it is a directory.`, {
          cause: error,
        });
      }
      throw error;
    }
  };

  return {
    description: `Commands run through bash -lc in a Daytona sandbox, starting in ${workdir}.`,
    run: async (options) => {
      const { command, abortSignal } = options;
      abortSignal?.throwIfAborted();
      if (abortSignal) return collect(await spawn(options));
      const result = await reach(() =>
        sandbox.process.run(command, processOptions(options)),
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
        const { items } = await reach(() => sandbox.fs.list(target));
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
        await reach(() => sandbox.fs.remove(resolve(path)));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
  };
}

function toError(error: unknown): Error {
  return Error.isError(error) ? error : new Error(String(error));
}
