import type {
  ExecHandle,
  Sandbox as MicrosandboxVm,
  SandboxBuilder,
  SandboxHandle,
} from 'microsandbox';
import { randomUUID } from 'node:crypto';

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
const MICROSANDBOX_DEFAULT_IMAGE = 'alpine';
const MICROSANDBOX_MAX_NAME_BYTES = 128;
const COMMAND_TIMEOUT_EXIT_CODE = 124;

type MicrosandboxSdk = typeof import('microsandbox');

export interface MicrosandboxSandboxOptions extends SandboxReadinessOptions {
  /**
   * Stable sandbox name. When provided, creation uses get-or-create
   * semantics: attach to the running sandbox of this name, resume it if it is
   * stopped (rootfs state intact), otherwise create it fresh. `dispose()`
   * stops the microVM but never removes it — the next
   * `createMicrosandboxSandbox({ name })` resumes where it left off.
   *
   * When omitted, an ephemeral sandbox with a generated name is created and
   * fully removed on `dispose()`.
   */
  name?: string;
  /** OCI image to boot (default `'alpine'`). Ignored when attaching. */
  image?: string;
  /** Number of virtual CPUs. */
  cpus?: number;
  /** Memory in MiB. */
  memory?: number;
  /** Environment variables baked into the sandbox at boot. */
  env?: Record<string, string>;
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
   * Escape hatch over the SDK builder for everything without a plain option
   * (volumes, network policy, secrets, user, idle timeout, …). Applied after
   * the factory's own setters, so it can override them. Only runs on
   * creation, not when attaching to an existing sandbox.
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

  let vm: MicrosandboxVm;
  try {
    vm = await acquireSandbox(sdk, { ...options, name, ephemeral, workdir });
    await vm.fs().mkdir(workdir);
  } catch (error) {
    throw normalizeMicrosandboxError(error, sdk);
  }

  const backend = createMicrosandboxMethods({
    sdk,
    vm,
    name,
    ephemeral,
    commandTimeout: options.commandTimeout,
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

async function acquireSandbox(
  sdk: MicrosandboxSdk,
  options: MicrosandboxSandboxOptions & {
    name: string;
    ephemeral: boolean;
    workdir: string;
  },
): Promise<MicrosandboxVm> {
  if (options.ephemeral || options.replace) {
    return buildSandbox(sdk, options);
  }

  let handle: SandboxHandle;
  try {
    handle = await sdk.Sandbox.get(options.name);
  } catch (error) {
    if (error instanceof sdk.SandboxNotFoundError) {
      return createFreshSandbox(sdk, options);
    }
    throw error;
  }

  if (handle.status === 'running') {
    return handle.connect();
  }
  if (handle.status === 'draining') {
    await handle.waitUntilStopped();
  }

  // A sandbox whose resume keeps failing would poison the name forever, so
  // mirror the Daytona adapter: drop it and rebuild from scratch.
  try {
    return await handle.start();
  } catch {
    await sdk.Sandbox.remove(options.name).catch(() => {});
    return buildSandbox(sdk, options);
  }
}

async function createFreshSandbox(
  sdk: MicrosandboxSdk,
  options: MicrosandboxSandboxOptions & {
    name: string;
    ephemeral: boolean;
    workdir: string;
  },
): Promise<MicrosandboxVm> {
  try {
    return await buildSandbox(sdk, options);
  } catch (error) {
    // Lost a create race against a concurrent caller — attach instead.
    if (error instanceof sdk.SandboxAlreadyExistsError) {
      const handle = await sdk.Sandbox.get(options.name);
      return handle.status === 'running' ? handle.connect() : handle.start();
    }
    throw error;
  }
}

function buildSandbox(
  sdk: MicrosandboxSdk,
  options: MicrosandboxSandboxOptions & {
    name: string;
    ephemeral: boolean;
    workdir: string;
  },
): Promise<MicrosandboxVm> {
  // `workdir()` alone fails boot validation when the image lacks the
  // directory (alpine has no /workspace), so patch it into the rootfs first.
  let builder = sdk.Sandbox.builder(options.name)
    .image(options.image ?? MICROSANDBOX_DEFAULT_IMAGE)
    .patch((patch) => patch.mkdir(options.workdir))
    .workdir(options.workdir);
  if (options.ephemeral) builder = builder.ephemeral(true);
  if (options.replace) builder = builder.replace();
  if (options.cpus !== undefined) builder = builder.cpus(options.cpus);
  if (options.memory !== undefined) builder = builder.memory(options.memory);
  if (options.env) builder = builder.envs(options.env);
  if (options.configure) builder = options.configure(builder);
  return builder.create();
}

function normalizeMicrosandboxError(
  error: unknown,
  sdk: MicrosandboxSdk,
): Error {
  const err = toError(error);
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
}): DisposableSandbox {
  const { sdk, vm, name, ephemeral, commandTimeout } = args;

  const spawn = (
    command: string,
    options: SpawnOptions = {},
  ): SandboxProcess => {
    return spawnMicrosandboxProcess(sdk, vm, command, {
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

    async readFile(path: string): Promise<string> {
      try {
        return await vm.fs().readToString(path);
      } catch (error) {
        throw new MicrosandboxCommandError(
          `Failed to read file "${path}": ${toError(error).message}`,
          toError(error),
        );
      }
    },

    async writeFiles(files): Promise<void> {
      try {
        const fs = vm.fs();
        for (const dir of uniqueParentDirectories(files.map((f) => f.path))) {
          await fs.mkdir(dir);
        }
        for (const file of files) {
          await fs.write(file.path, file.content);
        }
      } catch (error) {
        const err = toError(error);
        throw new MicrosandboxCommandError(
          `Failed to write files: ${err.message}`,
          err,
        );
      }
    },

    async dispose(): Promise<void> {
      try {
        await vm.stop();
      } catch {
        // Already stopped or mid-shutdown.
      }
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
  vm: MicrosandboxVm,
  command: string,
  options: SpawnOptions & { commandTimeout?: number },
): SandboxProcess {
  const stdout = createByteReadable();
  const stderr = createByteReadable();
  const exit = pumpExecStream({ sdk, vm, command, options, stdout, stderr });
  return { stdout: stdout.stream, stderr: stderr.stream, exit };
}

async function pumpExecStream(args: {
  sdk: MicrosandboxSdk;
  vm: MicrosandboxVm;
  command: string;
  options: SpawnOptions & { commandTimeout?: number };
  stdout: ByteReadable;
  stderr: ByteReadable;
}): Promise<ExitInfo> {
  const { sdk, vm, command, options, stdout, stderr } = args;
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
    handle = await vm.execStreamWith('sh', (builder) => {
      builder.args(['-lc', command]).stdinNull();
      if (options.cwd) builder.cwd(options.cwd);
      if (options.env) builder.envs(options.env);
      return builder;
    });
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
