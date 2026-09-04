import type {
  ExecHandle,
  Sandbox as MicrosandboxVm,
  SandboxBuilder,
} from 'microsandbox';
import { randomUUID } from 'node:crypto';

import { readFileContent } from './read-file.ts';
import type {
  CommandResult,
  DisposableSandbox,
  ExecuteCommandOptions,
  ExitInfo,
  SandboxProcess,
  SandboxReadinessOptions,
  SpawnOptions,
} from './types.ts';

export const MICROSANDBOX_DEFAULT_DESTINATION = '/workspace';
const MICROSANDBOX_DEFAULT_IMAGE = 'bash:5.3-alpine3.24';
const MICROSANDBOX_MAX_NAME_BYTES = 128;
const COMMAND_TIMEOUT_EXIT_CODE = 124;

type MicrosandboxSdk = typeof import('microsandbox');
type RunMicrosandboxOperation = <T>(
  operation: (vm: MicrosandboxVm) => Promise<T>,
) => Promise<T>;

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
   * Default working directory, created at boot (default `'/workspace'`).
   * Microsandbox images default to `/`, and common images ship no
   * `/workspace`, so the factory creates it — pass this same path as
   * `createBashTool`'s `destination`.
   */
  workdir?: string;
  /**
   * Replace an existing sandbox with the same name instead of attaching to
   * it. Requires `name`.
   */
  replace?: boolean;
  /** Per-command timeout in milliseconds for `executeCommand`. */
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

export class MicrosandboxCommandError extends MicrosandboxSandboxError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'MicrosandboxCommandError';
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
 * const result = await sandbox.executeCommand('echo hello');
 * ```
 *
 * @example Named sandbox (stopped on dispose, resumed on next create)
 * ```typescript
 * const sandbox = await createMicrosandboxSandbox({ name: chatId });
 * const { tools } = await createBashTool({
 *   sandbox,
 *   destination: MICROSANDBOX_DEFAULT_DESTINATION,
 * });
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
    // the reconnect then boots a fresh one), `workdir` is the bash
    // destination, and Bash is required. The SDK rejects a stray `replace()`
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
    await vm[Symbol.asyncDispose]().catch(() => {});
    if (ephemeral) await sdk.Sandbox.remove(name).catch(() => {});
    throw normalizeMicrosandboxError(error, sdk);
  }

  const backend = createMicrosandboxMethods({
    sdk,
    vm,
    name,
    ephemeral,
    commandTimeout: options.commandTimeout,
    reconnect: ephemeral
      ? undefined
      : () => sandboxBuilder(false).connectOrCreate(),
  });

  if (options.readiness) {
    try {
      await options.readiness(backend);
    } catch (error) {
      await backend.dispose().catch(() => {});
      throw error;
    }
  }
  return backend;
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
  if (err instanceof sdk.LibkrunfwNotFoundError) {
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

function createMicrosandboxMethods(args: {
  sdk: MicrosandboxSdk;
  vm: MicrosandboxVm;
  name: string;
  ephemeral: boolean;
  commandTimeout?: number;
  reconnect?: () => Promise<MicrosandboxVm>;
}): DisposableSandbox {
  const { sdk, name, ephemeral, commandTimeout, reconnect } = args;
  let vm = args.vm;
  let reconnecting: Promise<MicrosandboxVm> | undefined;

  const run: RunMicrosandboxOperation = async (operation) => {
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

  const spawn = (
    command: string,
    options: SpawnOptions = {},
  ): SandboxProcess => {
    return spawnMicrosandboxProcess(sdk, run, command, {
      ...options,
      commandTimeout,
    });
  };

  return {
    // `executeCommand` lowers onto the same streaming pump as `spawn` so a
    // single code path supports real cancellation. Cooperative abort (abandon
    // the promise, Daytona-style) is not an option here: the SDK is an
    // in-process native binding, so an abandoned exec keeps the guest process
    // and its libuv handle alive.
    async executeCommand(
      command: string,
      options?: ExecuteCommandOptions,
    ): Promise<CommandResult> {
      const proc = spawn(command, { signal: options?.signal });
      const [stdout, stderr, info] = await Promise.all([
        readAllText(proc.stdout),
        readAllText(proc.stderr),
        proc.exit,
      ]);
      if (info.signal === 'SIGKILL') {
        return abortedCommandResult();
      }
      return { stdout, stderr, exitCode: info.code ?? 1 };
    },

    spawn,

    async readFile(path, options) {
      try {
        const bytes = await run((vm) => vm.fs().read(path));
        return readFileContent(bytes, options);
      } catch (error) {
        throw new MicrosandboxCommandError(
          `Failed to read file "${path}": ${toError(error).message}`,
          toError(error),
        );
      }
    },

    async exists(path) {
      try {
        return await run((vm) => vm.fs().exists(path));
      } catch (error) {
        throw new MicrosandboxCommandError(
          `Failed to check "${path}": ${toError(error).message}`,
          toError(error),
        );
      }
    },

    async writeFiles(files): Promise<void> {
      try {
        await run(async (vm) => {
          const fs = vm.fs();
          for (const dir of uniqueParentDirectories(files.map((f) => f.path))) {
            await fs.mkdir(dir);
          }
          for (const file of files) {
            await fs.write(file.path, file.content);
          }
        });
      } catch (error) {
        const err = toError(error);
        throw new MicrosandboxCommandError(
          `Failed to write files: ${err.message}`,
          err,
        );
      }
    },

    async dispose(): Promise<void> {
      await vm[Symbol.asyncDispose]();
      if (ephemeral) {
        await sdk.Sandbox.remove(name).catch(() => {});
      }
    },

    [Symbol.asyncDispose](this: DisposableSandbox): Promise<void> {
      return this.dispose();
    },
  };
}

function spawnMicrosandboxProcess(
  sdk: MicrosandboxSdk,
  run: RunMicrosandboxOperation,
  command: string,
  options: SpawnOptions & { commandTimeout?: number },
): SandboxProcess {
  const stdout = createByteReadable();
  const stderr = createByteReadable();
  const exit = pumpExecStream({ sdk, run, command, options, stdout, stderr });
  return { stdout: stdout.stream, stderr: stderr.stream, exit };
}

async function pumpExecStream(args: {
  sdk: MicrosandboxSdk;
  run: RunMicrosandboxOperation;
  command: string;
  options: SpawnOptions & { commandTimeout?: number };
  stdout: ByteReadable;
  stderr: ByteReadable;
}): Promise<ExitInfo> {
  const { sdk, run, command, options, stdout, stderr } = args;
  const { signal } = options;

  let handle: ExecHandle | undefined;
  let aborted = signal?.aborted ?? false;
  let timedOut = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const abort = () => {
    aborted = true;
    handle?.kill().catch(() => {});
  };

  if (aborted) {
    stdout.close();
    stderr.close();
    return abortedExitInfo();
  }
  signal?.addEventListener('abort', abort, { once: true });

  try {
    handle = await run((vm) =>
      vm.execStreamWith('bash', (builder) => {
        builder.args(['-lc', command]).stdinNull();
        if (options.cwd) builder.cwd(options.cwd);
        if (options.env) builder.envs(options.env);
        return builder;
      }),
    );
    if (aborted) {
      return abortedExitInfo();
    }
    // The exec builder's own `timeout()` only fires on buffered exec and is
    // silently ignored by the stream variant (verified against 0.6.4), so the
    // deadline is enforced host-side with the same kill switch abort uses.
    if (options.commandTimeout) {
      const startedHandle = handle;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        startedHandle.kill().catch(() => {});
      }, options.commandTimeout);
      timeoutTimer.unref();
    }

    let code: number | null = null;
    for await (const event of handle) {
      if (event.kind === 'stdout') stdout.enqueue(event.data);
      else if (event.kind === 'stderr') stderr.enqueue(event.data);
      else if (event.kind === 'exited') code = event.code;
    }
    // A killed guest exec reports exit code 0 in its `exited` event, so the
    // aborted/timedOut flags — not the reported code — decide the outcome.
    if (aborted) {
      return abortedExitInfo();
    }
    if (timedOut) {
      stderr.enqueue(new TextEncoder().encode('Command timed out'));
      return { code: COMMAND_TIMEOUT_EXIT_CODE, signal: null, success: false };
    }
    return { code, signal: null, success: code === 0 };
  } catch (error) {
    if (aborted) {
      return abortedExitInfo();
    }
    if (timedOut || error instanceof sdk.ExecTimeoutError) {
      stderr.enqueue(new TextEncoder().encode('Command timed out'));
      return { code: COMMAND_TIMEOUT_EXIT_CODE, signal: null, success: false };
    }
    const err = toError(error);
    stdout.error(err);
    stderr.error(err);
    throw err;
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', abort);
    stdout.close();
    stderr.close();
    // Kills the guest process if the pump exits early; no-op after a natural
    // exit (and never throws). Guarantees no exec outlives its SandboxProcess.
    await handle?.[Symbol.asyncDispose]();
  }
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
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;

  return {
    stream: new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        closed = true;
      },
    }),
    enqueue(chunk) {
      if (closed || chunk.length === 0) return;
      controller?.enqueue(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      controller?.close();
    },
    error(error) {
      if (closed) return;
      closed = true;
      controller?.error(error);
    },
  };
}

async function readAllText(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function abortedCommandResult(): CommandResult {
  return {
    stdout: '',
    stderr: 'Command aborted',
    exitCode: 1,
  };
}

function abortedExitInfo(): ExitInfo {
  return {
    code: null,
    signal: 'SIGKILL',
    success: false,
  };
}

function uniqueParentDirectories(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const index = path.lastIndexOf('/');
    if (index > 0) {
      dirs.add(path.slice(0, index));
    }
  }
  return [...dirs];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
