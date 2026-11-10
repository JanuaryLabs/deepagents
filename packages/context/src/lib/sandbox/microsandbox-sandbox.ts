import {
  type Experimental_SandboxFileStat,
  type Experimental_SandboxProcess,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
  extractLines,
} from '@ai-sdk/provider-utils';
import type {
  Sandbox as MicrosandboxVm,
  SandboxBuilder,
  SandboxFsOps,
} from 'microsandbox';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { text } from 'node:stream/consumers';

import { FILE_STAT_TYPES, bufferEncoding } from './container-session.ts';
import type { DisposableSandbox, SandboxReadinessOptions } from './types.ts';

export const MICROSANDBOX_DEFAULT_DESTINATION = '/workspace';
const MICROSANDBOX_DEFAULT_IMAGE = 'bash:5.3-alpine3.24';
const MICROSANDBOX_MAX_NAME_BYTES = 128;
const COMMAND_TIMEOUT_EXIT_CODE = 124;

// The SDK has no typed not-found error. The guest's errno ends the message, as
// in "sandbox fs error: stat: No such file or directory (os error 2)": ENOENT
// is 2, and ENOTDIR (20) is a path under a file.
const NOT_FOUND_MESSAGE = /\(os error (?:2|20)\)$/;

type MicrosandboxSdk = typeof import('microsandbox');
type WithVm = <T>(operation: (vm: MicrosandboxVm) => Promise<T>) => Promise<T>;

export interface MicrosandboxSandboxOptions extends SandboxReadinessOptions {
  /**
   * Stable sandbox name. When provided, the SDK connects to the running
   * sandbox of this name, resumes it if stopped (rootfs state intact), or
   * creates it. `dispose()` follows SDK lifecycle ownership and never removes
   * a named sandbox. Configure the builder with `detached(true)` when the
   * sandbox must outlive the client that creates or resumes it.
   *
   * When omitted, an ephemeral sandbox with a generated name is created and
   * fully removed on `dispose()`.
   */
  name?: string;
  /**
   * The directory commands start in and relative paths resolve against,
   * created at boot (default `'/workspace'`). Microsandbox images default to
   * `/`, and common images ship no `/workspace`, so the factory creates it.
   */
  workdir?: string;
  /**
   * Replace an existing sandbox with the same name instead of attaching to
   * it. Requires `name`.
   */
  replace?: boolean;
  /** Per-command timeout in milliseconds for `run` and `spawn`. */
  commandTimeout?: number;
  /**
   * Fluent access to the SDK builder for everything the factory does not
   * own: image (default `'bash:5.3-alpine3.24'`), cpus, memory, env,
   * volumes, network policy, secrets, user, idle timeout, ….
   *
   * The factory applies its own setters after this callback — `workdir`,
   * the persistence implied by `name`, and the required Bash shell — so
   * `configure` cannot change what the lifecycle logic relies on. Runs on
   * every connect; existing sandbox configuration wins when connecting.
   */
  configure?: (builder: SandboxBuilder) => SandboxBuilder;
}

/**
 * Named `MicrosandboxSandboxError` (not `MicrosandboxError`) because the SDK
 * itself exports a `MicrosandboxError` base class and this module is
 * re-exported through the package barrel.
 */
export class MicrosandboxSandboxError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'MicrosandboxSandboxError';
    this.cause = cause;
  }
}

export class MicrosandboxNotAvailableError extends MicrosandboxSandboxError {
  constructor(cause?: Error) {
    super(
      'microsandbox is not installed or its runtime is unavailable. Install it with: npm install microsandbox (requires Node >= 22 and hardware virtualization: Apple silicon, Linux with KVM, or Windows with WHP)',
      cause,
    );
    this.name = 'MicrosandboxNotAvailableError';
  }
}

export class MicrosandboxCreationError extends MicrosandboxSandboxError {
  constructor(message: string, cause?: Error) {
    super(`Failed to create microsandbox: ${message}`, cause);
    this.name = 'MicrosandboxCreationError';
  }
}

/**
 * Creates a sandbox backed by a microsandbox microVM.
 *
 * Each sandbox is a hardware-isolated VM with its own Linux kernel, booted
 * in-process through the SDK's native binding — no daemon, no API key.
 * Boots standard OCI images in about a second; per-command latency inside a
 * running sandbox is single-digit milliseconds.
 *
 * The factory never touches the SDK's process-global backend selection
 * (`setDefaultBackend`) — callers targeting the cloud backend configure it
 * themselves before calling this.
 *
 * Requires the optional peer dependency `microsandbox`.
 *
 * @example Ephemeral sandbox (removed on dispose)
 * ```typescript
 * await using sandbox = await createMicrosandboxSandbox();
 * const result = await sandbox.run({ command: 'echo hello' });
 * ```
 *
 * @example Named sandbox (stopped on dispose, resumed on next create)
 * ```typescript
 * const sandbox = await createMicrosandboxSandbox({ name: chatId });
 * const { tools } = await createBashTool({ sandbox });
 * ```
 */
export async function createMicrosandboxSandbox(
  options: MicrosandboxSandboxOptions = {},
): Promise<DisposableSandbox> {
  validateMicrosandboxOptions(options);
  const sdk = await importMicrosandbox();

  const ephemeral = options.name === undefined;
  const name = options.name ?? `deepagents-msb-${randomUUID()}`;
  const workdir = options.workdir ?? MICROSANDBOX_DEFAULT_DESTINATION;

  const sandboxBuilder = (replace: boolean) => {
    // `workdir()` alone fails boot validation when the image lacks the
    // directory, so patch it into the rootfs first.
    let builder = sdk.Sandbox.builder(name)
      .image(MICROSANDBOX_DEFAULT_IMAGE)
      .patch((patch) => patch.mkdir(workdir));
    if (options.configure) builder = options.configure(builder);
    // Factory-owned setters go last so `configure` cannot override what the
    // lifecycle logic reads: `name` decides persistence (an ephemeral flag
    // from `configure` lets the runtime remove a named sandbox on stop, and
    // the reconnect then boots a fresh one), `workdir` is the session's base
    // directory, and Bash is required. The SDK rejects a stray `replace()`
    // on the `connectOrCreate` path.
    builder = builder.workdir(workdir).ephemeral(ephemeral).shell('bash');
    return replace ? builder.replace() : builder;
  };

  let vm: MicrosandboxVm;
  try {
    const builder = sandboxBuilder(options.replace === true);
    vm = await (ephemeral || options.replace
      ? builder.create()
      : builder.connectOrCreate());
  } catch (error) {
    throw normalizeMicrosandboxError(error, sdk);
  }

  try {
    await vm.fs().mkdir(workdir);
    await assertMicrosandboxBash(vm);
  } catch (error) {
    // Stops the VM, which removes an ephemeral one; never rejects.
    await vm[Symbol.asyncDispose]();
    throw normalizeMicrosandboxError(error, sdk);
  }

  const sandbox = microsandboxSession({
    sdk,
    vm,
    workdir,
    commandTimeout: options.commandTimeout,
    reconnect: ephemeral
      ? undefined
      : () => sandboxBuilder(false).connectOrCreate(),
  });

  if (options.readiness) {
    try {
      await options.readiness(sandbox);
    } catch (error) {
      await sandbox.dispose();
      throw error;
    }
  }
  return sandbox;
}

async function importMicrosandbox(): Promise<MicrosandboxSdk> {
  try {
    return await import('microsandbox');
  } catch (error) {
    throw new MicrosandboxNotAvailableError(toError(error));
  }
}

async function assertMicrosandboxBash(vm: MicrosandboxVm): Promise<void> {
  try {
    const result = await vm.exec('bash', ['-lc', ':']);
    if (result.code === 0) return;
    throw new Error(result.stderr() || `exit code ${result.code}`);
  } catch (error) {
    const err = toError(error);
    throw new MicrosandboxCreationError(
      `Bash is required to execute sandbox commands but could not be started: ${err.message}`,
      err,
    );
  }
}

function normalizeMicrosandboxError(
  error: unknown,
  sdk: MicrosandboxSdk,
): Error {
  const err = toError(error);
  if (err instanceof MicrosandboxSandboxError) return err;
  if (
    err instanceof sdk.LibkrunfwNotFoundError ||
    err instanceof sdk.RuntimeNotInstalledError ||
    err instanceof sdk.RuntimeIncompleteError
  ) {
    return new MicrosandboxNotAvailableError(err);
  }
  if (err instanceof sdk.MicrosandboxError) {
    return err;
  }
  return new MicrosandboxCreationError(err.message, err);
}

function validateMicrosandboxOptions(
  options: MicrosandboxSandboxOptions,
): void {
  if (
    options.name !== undefined &&
    Buffer.byteLength(options.name, 'utf-8') > MICROSANDBOX_MAX_NAME_BYTES
  ) {
    throw new MicrosandboxSandboxError(
      `Microsandbox names are limited to ${MICROSANDBOX_MAX_NAME_BYTES} UTF-8 bytes.`,
    );
  }
  if (options.replace && options.name === undefined) {
    throw new MicrosandboxSandboxError(
      'Microsandbox options can only include "replace" together with "name" — an unnamed sandbox is always created fresh.',
    );
  }
}

/**
 * The AI SDK sandbox session of a running microVM. File calls use the SDK's
 * filesystem; commands run through its exec stream, which gives live output,
 * stdin and a kill.
 */
function microsandboxSession(args: {
  sdk: MicrosandboxSdk;
  vm: MicrosandboxVm;
  workdir: string;
  commandTimeout?: number;
  reconnect?: () => Promise<MicrosandboxVm>;
}): DisposableSandbox {
  const { sdk, workdir, commandTimeout, reconnect } = args;
  let vm = args.vm;
  let reconnecting: Promise<MicrosandboxVm> | undefined;

  const withVm: WithVm = async (operation) => {
    try {
      return await operation(vm);
    } catch (error) {
      if (!reconnect || !(error instanceof sdk.SandboxNotRunningError)) {
        throw error;
      }
      reconnecting ??= reconnect().finally(() => {
        reconnecting = undefined;
      });
      vm = await reconnecting;
      return operation(vm);
    }
  };
  const withFs = <T>(operation: (fs: SandboxFsOps) => Promise<T>) =>
    withVm((current) => operation(current.fs()));

  const isNotFound = (error: unknown) =>
    error instanceof sdk.SandboxFsOpsError &&
    NOT_FOUND_MESSAGE.test(error.message);

  const orNull = async <T>(operation: () => Promise<T>): Promise<T | null> => {
    try {
      return await operation();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  // Joined, not normalized, so that `link/..` follows the link, as it does in
  // a command. The exec `cwd` must be absolute too: a relative one fails as
  // `spawn "bash": No such file or directory`.
  const resolve = (path: string) =>
    posix.isAbsolute(path) ? path : `${workdir}/${path}`;

  const statAt = async (
    path: string,
  ): Promise<Experimental_SandboxFileStat | null> => {
    const metadata = await orNull(() => withFs((fs) => fs.stat(path)));
    if (!metadata) return null;
    const type = FILE_STAT_TYPES.find((known) => known === metadata.kind);
    if (!type) {
      throw new Error(
        `Failed to stat "${path}": unknown type "${metadata.kind}"`,
      );
    }
    return { type, size: metadata.size };
  };

  /**
   * Whether `path` can be read. `fs.read` and `fs.readStream` of a directory
   * never settle (SDK 0.7.8), so the trial is unsafe and a stat goes first.
   */
  const readable = async (path: string): Promise<boolean> => {
    const stat = await statAt(path);
    if (stat?.type === 'directory') {
      throw new Error(`Cannot read "${path}": it is a directory.`);
    }
    return stat !== null;
  };

  /** `fs.write` creates no parents, so a missing parent is created on failure. */
  const withParents = async <T>(
    path: string,
    operation: (fs: SandboxFsOps) => Promise<T>,
  ): Promise<T> => {
    try {
      return await withFs(operation);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await withFs((fs) => fs.mkdir(posix.dirname(path)));
      return withFs(operation);
    }
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
    const { command, workingDirectory, env, abortSignal, stdin } = options;
    abortSignal?.throwIfAborted();
    const handle = await withVm((current) =>
      current.execStreamWith('bash', (builder) => {
        builder
          .args(['-lc', command])
          .cwd(
            workingDirectory === undefined
              ? workdir
              : resolve(workingDirectory),
          );
        if (env) builder.envs(env);
        return stdin ? builder.stdinPipe() : builder.stdinNull();
      }),
    );
    const sink = stdin ? await handle.takeStdin() : null;

    const stdout = createByteReadable();
    const stderr = createByteReadable();
    let exited = false;
    let timedOut = false;
    // A kill after the exit fails with `delivery_unconfirmed` instead of
    // doing nothing.
    const kill = async () => {
      if (exited) return;
      await handle.kill().catch((error: unknown) => {
        if (!exited) throw error;
      });
    };
    const onAbort = () => {
      void kill().catch(() => {});
    };
    // The exec builder's `timeout()` stops a streamed command too, but its exit
    // code is -1, as for any signal, so the deadline is kept here to tell a
    // timeout apart.
    const timer = commandTimeout
      ? setTimeout(() => {
          timedOut = true;
          onAbort();
        }, commandTimeout).unref()
      : undefined;

    const pump = async (): Promise<number> => {
      let code: number | undefined;
      for await (const event of handle) {
        if (event.kind === 'stdout') stdout.enqueue(event.data);
        else if (event.kind === 'stderr') stderr.enqueue(event.data);
        else if (event.kind === 'exited') code = event.code;
      }
      if (timedOut) {
        stderr.enqueue(new TextEncoder().encode('Command timed out'));
        return COMMAND_TIMEOUT_EXIT_CODE;
      }
      if (code === undefined) {
        throw new MicrosandboxSandboxError(
          `The command ended without an exit code: ${command}`,
        );
      }
      return code;
    };
    const exitCode = pump()
      .then(
        (code) => {
          stdout.close();
          stderr.close();
          return code;
        },
        async (error: unknown) => {
          const err = toError(error);
          stdout.error(err);
          stderr.error(err);
          // Kills a guest process the pump lost. Not called after an exit: a
          // kill then waits out a delivery deadline of about 3 s.
          await handle[Symbol.asyncDispose]();
          throw err;
        },
      )
      .finally(() => {
        exited = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
      });
    exitCode.catch(() => {});

    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });

    return {
      stdout: stdout.stream,
      stderr: stderr.stream,
      ...(sink
        ? {
            stdin: new WritableStream<Uint8Array>({
              write: (chunk) => sink.write(chunk),
              close: () => sink.close(),
              abort: () => sink.close(),
            }),
          }
        : {}),
      wait: async () => ({
        exitCode: await exitCode.finally(() => abortSignal?.throwIfAborted()),
      }),
      kill,
    };
  }

  const readBinaryFile: DisposableSandbox['readBinaryFile'] = async ({
    path,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    if (!(await readable(target))) return null;
    return orNull(() => withFs((fs) => fs.read(target)));
  };

  const writeBinaryFile: DisposableSandbox['writeBinaryFile'] = async ({
    path,
    content,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const target = resolve(path);
    await withParents(target, (fs) => fs.write(target, content));
  };

  const dispose = async () => {
    // Stops a VM this client owns, which removes an ephemeral one; never
    // rejects, so a second call is harmless.
    await vm[Symbol.asyncDispose]();
  };

  return {
    description: `Commands run through bash -lc in a Microsandbox microVM, starting in ${workdir}.`,
    run: async (options) => {
      const process = await spawn(options);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        text(process.stdout),
        text(process.stderr),
        process.wait(),
      ]);
      return { stdout, stderr, exitCode };
    },
    spawn,
    readBinaryFile,
    readFile: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const target = resolve(path);
      if (!(await readable(target))) return null;
      const stream = await orNull(() => withFs((fs) => fs.readStream(target)));
      return stream && ReadableStream.from(stream);
    },
    readTextFile: async ({ startLine, endLine, encoding, ...options }) => {
      const bytes = await readBinaryFile(options);
      if (!bytes) return null;
      return extractLines({
        text: Buffer.from(bytes).toString(bufferEncoding(encoding)),
        startLine,
        endLine,
      });
    },
    writeBinaryFile,
    writeFile: async ({ path, content, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const target = resolve(path);
      await using sink = await withParents(target, (fs) =>
        fs.writeStream(target),
      );
      for await (const chunk of content) await sink.write(chunk);
      await sink.close();
    },
    writeTextFile: ({ content, encoding, ...options }) =>
      writeBinaryFile({
        ...options,
        content: Buffer.from(content, bufferEncoding(encoding)),
      }),
    stat: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      return statAt(resolve(path));
    },
    listDirectory: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      const target = resolve(path);
      try {
        const entries = await withFs((fs) => fs.list(target));
        return entries.map((entry) => ({
          name: posix.basename(entry.path),
          type: entry.kind,
        }));
      } catch (error) {
        // A file and a path under a file both fail with ENOTDIR; only the
        // file exists.
        if (!isNotFound(error) || (await statAt(target))) throw error;
        return null;
      }
    },
    deleteFile: async ({ path, abortSignal }) => {
      abortSignal?.throwIfAborted();
      try {
        await withFs((fs) => fs.remove(resolve(path)));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}

interface ByteReadable {
  stream: ReadableStream<Uint8Array>;
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(error: Error): void;
}

/**
 * One exec event stream demultiplexes into two web streams, so honoring
 * per-stream backpressure would deadlock (waiting on stdout's `pull` while
 * the next event is stderr stalls both). Like the Daytona backend, the pump
 * enqueues eagerly and lets the unread side buffer.
 */
function createByteReadable(): ByteReadable {
  const ended: Omit<ByteReadable, 'stream'> = {
    enqueue() {},
    close() {},
    error() {},
  };
  let sink = ended;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = {
        enqueue(chunk) {
          if (chunk.length > 0) controller.enqueue(chunk);
        },
        close() {
          sink = ended;
          controller.close();
        },
        error(error) {
          sink = ended;
          controller.error(error);
        },
      };
    },
    cancel() {
      sink = ended;
    },
  });

  return {
    stream,
    enqueue: (chunk) => sink.enqueue(chunk),
    close: () => sink.close(),
    error: (error) => sink.error(error),
  };
}

function toError(error: unknown): Error {
  return Error.isError(error) ? error : new Error(String(error));
}
