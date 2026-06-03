import type {
  CreateSandboxFromImageParams,
  CreateSandboxFromSnapshotParams,
  Daytona,
  DaytonaConfig,
  Sandbox,
} from '@daytona/sdk';
import { type CommandResult } from 'bash-tool';
import { randomUUID } from 'node:crypto';

import type {
  DisposableSandbox,
  ExecuteCommandOptions,
  ExitInfo,
  SandboxProcess,
  SpawnOptions,
} from './types.ts';

export const DAYTONA_DEFAULT_DESTINATION = '/home/daytona';
const DAYTONA_EXIT_POLL_INTERVAL_MS = 250;
const DAYTONA_EXIT_POLL_TIMEOUT_MS = 30_000;

type DaytonaSdk = typeof import('@daytona/sdk');

export interface DaytonaResources {
  cpu?: number;
  gpu?: number;
  memory?: number;
  disk?: number;
}

export interface DaytonaVolumeMount {
  volumeId: string;
  mountPath: string;
  [key: string]: unknown;
}

export interface DaytonaSandboxOptions {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
  apiUrl?: string;
  target?: string;
  otelEnabled?: boolean;
  experimental?: Record<string, unknown>;
  /**
   * Existing Daytona sandbox id or name to attach to. Attached sandboxes are
   * preserved on dispose unless `deleteOnDispose` is explicitly true.
   */
  sandboxId?: string;
  /**
   * Stable sandbox name. When provided without `sandboxId`, creation uses
   * get-or-create semantics: attach to the existing sandbox of this name if one
   * is found (starting it if it is stopped), otherwise create it from the
   * supplied image/snapshot, env vars, volumes, and lifecycle intervals. A named
   * sandbox is treated as shared/persistent, so `deleteOnDispose` defaults to
   * `false`; pass `deleteOnDispose: true` to override. Incompatible with
   * `sandboxId`.
   */
  name?: string;
  user?: string;
  snapshot?: string;
  image?: string;
  language?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  resources?: DaytonaResources;
  volumes?: DaytonaVolumeMount[];
  networkAllowList?: string;
  networkBlockAll?: boolean;
  autoStopInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  ephemeral?: boolean;
  createTimeout?: number;
  startTimeout?: number;
  deleteTimeout?: number;
  commandTimeout?: number;
  onSnapshotCreateLogs?: (chunk: string) => void;
  deleteOnDispose?: boolean;
}

export class DaytonaSandboxError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'DaytonaSandboxError';
    this.cause = cause;
  }
}

export class DaytonaNotAvailableError extends DaytonaSandboxError {
  constructor(cause?: Error) {
    super(
      '@daytona/sdk is not installed. Install it with: npm install @daytona/sdk',
      cause,
    );
    this.name = 'DaytonaNotAvailableError';
  }
}

export class DaytonaCreationError extends DaytonaSandboxError {
  constructor(message: string, cause?: Error) {
    super(`Failed to create Daytona sandbox: ${message}`, cause);
    this.name = 'DaytonaCreationError';
  }
}

export class DaytonaCommandError extends DaytonaSandboxError {
  constructor(message: string, cause?: Error) {
    super(message, cause);
    this.name = 'DaytonaCommandError';
  }
}

export async function createDaytonaSandbox(
  options: DaytonaSandboxOptions = {},
): Promise<DisposableSandbox> {
  validateDaytonaOptions(options);

  const sdk = await importDaytonaSdk();
  let client: Daytona;
  try {
    client = new sdk.Daytona(createDaytonaConfig(options));
  } catch (error) {
    throw normalizeDaytonaError(error, sdk);
  }

  const attached = options.sandboxId !== undefined;
  const reuseByName = !attached && options.name !== undefined;
  const deleteOnDispose =
    options.deleteOnDispose ?? (!attached && !reuseByName);

  let sandbox: Sandbox;
  try {
    if (reuseByName) {
      sandbox = await acquireReusedSandbox(client, options, sdk);
    } else if (attached) {
      sandbox = await client.get(options.sandboxId as string);
      await startIfStopped(sandbox, options);
    } else {
      sandbox = await createSandbox(client, options);
    }
  } catch (error) {
    throw normalizeDaytonaError(error, sdk);
  }

  return createDaytonaSandboxMethods({
    client,
    sandbox,
    commandTimeout: options.commandTimeout,
    deleteOnDispose,
    deleteTimeout: options.deleteTimeout,
  });
}

async function acquireReusedSandbox(
  client: Daytona,
  options: DaytonaSandboxOptions,
  sdk: DaytonaSdk,
): Promise<Sandbox> {
  try {
    const sandbox = await client.get(options.name as string);
    await startIfStopped(sandbox, options);
    return sandbox;
  } catch (error) {
    if (!(error instanceof sdk.DaytonaNotFoundError)) {
      throw error;
    }
    return createSandbox(client, options);
  }
}

async function startIfStopped(
  sandbox: Sandbox,
  options: DaytonaSandboxOptions,
): Promise<void> {
  if (sandbox.state && sandbox.state !== 'started') {
    await sandbox.start?.(options.startTimeout ?? options.createTimeout);
  }
}

function normalizeDaytonaError(error: unknown, sdk: DaytonaSdk): Error {
  const err = toError(error);
  if (err instanceof sdk.DaytonaError) {
    return err;
  }
  return new DaytonaCreationError(err.message, err);
}

async function importDaytonaSdk(): Promise<DaytonaSdk> {
  try {
    const mod = await import('@daytona/sdk');
    if (typeof mod.Daytona !== 'function') {
      throw new DaytonaSandboxError(
        '@daytona/sdk did not export a Daytona constructor',
      );
    }
    return mod;
  } catch (error) {
    if (error instanceof DaytonaSandboxError) {
      throw error;
    }
    const err = toError(error);
    if (isMissingDaytonaSdk(err)) {
      throw new DaytonaNotAvailableError(err);
    }
    throw err;
  }
}

function createDaytonaConfig(options: DaytonaSandboxOptions): DaytonaConfig {
  return compactObject({
    apiKey: options.apiKey,
    jwtToken: options.jwtToken,
    organizationId: options.organizationId,
    apiUrl: options.apiUrl,
    target: options.target,
    otelEnabled: options.otelEnabled,
    _experimental: options.experimental,
  });
}

function createSandbox(
  client: Daytona,
  options: DaytonaSandboxOptions,
): Promise<Sandbox> {
  const base = compactObject({
    name: options.name,
    user: options.user,
    language: options.language,
    envVars: options.envVars,
    labels: options.labels,
    public: options.public,
    autoStopInterval: options.autoStopInterval,
    autoArchiveInterval: options.autoArchiveInterval,
    autoDeleteInterval: options.autoDeleteInterval,
    volumes: options.volumes,
    networkBlockAll: options.networkBlockAll,
    networkAllowList: options.networkAllowList,
    ephemeral: options.ephemeral,
  });

  if (options.image !== undefined) {
    const params: CreateSandboxFromImageParams = compactObject({
      ...base,
      image: options.image,
      resources: options.resources,
    });
    return client.create(params, {
      timeout: options.createTimeout,
      onSnapshotCreateLogs: options.onSnapshotCreateLogs,
    });
  }

  const params: CreateSandboxFromSnapshotParams = compactObject({
    ...base,
    snapshot: options.snapshot,
  });
  return client.create(Object.keys(params).length > 0 ? params : undefined, {
    timeout: options.createTimeout,
  });
}

function validateDaytonaOptions(options: DaytonaSandboxOptions): void {
  if (options.image && options.snapshot) {
    throw new DaytonaSandboxError(
      'Daytona sandbox options cannot include both "image" and "snapshot". Choose one environment source.',
    );
  }
  if (options.resources && !options.image) {
    throw new DaytonaSandboxError(
      'Daytona sandbox options can only include "resources" when creating from "image". The Daytona SDK does not apply resources during default or snapshot creation.',
    );
  }

  if (!options.sandboxId) {
    return;
  }

  const creationOnlyFields: Array<keyof DaytonaSandboxOptions> = [
    'name',
    'user',
    'snapshot',
    'image',
    'language',
    'envVars',
    'labels',
    'public',
    'resources',
    'volumes',
    'networkAllowList',
    'networkBlockAll',
    'autoStopInterval',
    'autoArchiveInterval',
    'autoDeleteInterval',
    'ephemeral',
    'onSnapshotCreateLogs',
  ];
  const present = creationOnlyFields.filter((field) => {
    return options[field] !== undefined;
  });
  if (present.length > 0) {
    throw new DaytonaSandboxError(
      `Daytona sandbox options cannot combine "sandboxId" with creation options: ${present.join(', ')}`,
    );
  }
}

function createDaytonaSandboxMethods(args: {
  client: Daytona;
  sandbox: Sandbox;
  commandTimeout?: number;
  deleteOnDispose: boolean;
  deleteTimeout?: number;
}): DisposableSandbox {
  const { client, sandbox, commandTimeout, deleteOnDispose, deleteTimeout } =
    args;
  let disposed = false;

  const executeCommand = async (
    command: string,
    options?: ExecuteCommandOptions,
  ): Promise<CommandResult> => {
    if (options?.signal?.aborted) {
      return abortedCommandResult();
    }

    let aborted = false;
    const abort = () => {
      aborted = true;
    };

    options?.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (aborted || options?.signal?.aborted) {
        return abortedCommandResult();
      }

      const response = await sandbox.process.executeCommand(
        command,
        undefined,
        undefined,
        commandTimeout,
      );
      if (aborted) return abortedCommandResult();
      return {
        stdout: response.result ?? response.artifacts?.stdout ?? '',
        stderr: '',
        exitCode: response.exitCode ?? 0,
      };
    } catch (error) {
      if (aborted) return abortedCommandResult();
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      };
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? String(error),
        exitCode: err.exitCode ?? 1,
      };
    } finally {
      options?.signal?.removeEventListener('abort', abort);
    }
  };

  return {
    executeCommand,

    spawn(command, options) {
      return spawnDaytonaProcess(sandbox, command, {
        ...options,
        commandTimeout,
      });
    },

    async readFile(path: string): Promise<string> {
      try {
        const bytes = await sandbox.fs.downloadFile(path);
        return Buffer.from(bytes).toString('utf-8');
      } catch (error) {
        throw new DaytonaCommandError(
          `Failed to read file "${path}": ${toError(error).message}`,
          toError(error),
        );
      }
    },

    async writeFiles(files): Promise<void> {
      try {
        for (const dir of uniqueParentDirectories(files.map((f) => f.path))) {
          const result = await executeCommand(`mkdir -p ${shellQuote(dir)}`);
          if (result.exitCode !== 0) {
            throw new DaytonaCommandError(
              `Failed to create directory "${dir}": ${result.stderr}`,
            );
          }
        }
        await sandbox.fs.uploadFiles(
          files.map((file) => ({
            source: Buffer.from(file.content),
            destination: file.path,
          })),
        );
      } catch (error) {
        if (error instanceof DaytonaSandboxError) throw error;
        const err = toError(error);
        throw new DaytonaCommandError(
          `Failed to write files: ${err.message}`,
          err,
        );
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        if (deleteOnDispose) {
          if (sandbox.delete) await sandbox.delete(deleteTimeout);
          else if (client.delete) await client.delete(sandbox, deleteTimeout);
        }
      } finally {
        await client[Symbol.asyncDispose]?.().catch(() => {});
      }
    },
  };
}

function spawnDaytonaProcess(
  sandbox: Sandbox,
  command: string,
  options: SpawnOptions & { commandTimeout?: number } = {},
): SandboxProcess {
  const sessionId = createSessionId('spawn');
  const stdout = createTextReadable();
  const stderr = createTextReadable();

  const exit = runSpawnedSession({
    sandbox,
    sessionId,
    command: buildSessionCommand(command, options),
    signal: options.signal,
    commandTimeout: options.commandTimeout,
    stdout,
    stderr,
  });

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exit,
  };
}

async function runSpawnedSession(args: {
  sandbox: Sandbox;
  sessionId: string;
  command: string;
  signal?: AbortSignal;
  commandTimeout?: number;
  stdout: TextReadable;
  stderr: TextReadable;
}): Promise<ExitInfo> {
  const {
    sandbox,
    sessionId,
    command,
    signal,
    commandTimeout,
    stdout,
    stderr,
  } = args;
  let sessionCreated = false;
  let aborted = signal?.aborted ?? false;
  let resolveAbort: (() => void) | undefined;
  const abortPromise = new Promise<'aborted'>((resolve) => {
    resolveAbort = () => resolve('aborted');
  });
  const abort = () => {
    aborted = true;
    resolveAbort?.();
    if (sessionCreated) {
      sandbox.process.deleteSession(sessionId).catch(() => {});
    }
  };

  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  try {
    await sandbox.process.createSession(sessionId);
    sessionCreated = true;
    if (aborted) return abortedExitInfo();

    const response = await sandbox.process.executeSessionCommand(
      sessionId,
      {
        command,
        runAsync: true,
        suppressInputEcho: true,
      },
      commandTimeout,
    );
    const commandId = response.cmdId;
    if (!commandId) {
      throw new DaytonaCommandError(
        'Daytona did not return a command id for the spawned session command.',
      );
    }
    if (aborted) return abortedExitInfo();

    const logsTask = sandbox.process.getSessionCommandLogs(
      sessionId,
      commandId,
      (chunk) => stdout.enqueue(chunk),
      (chunk) => stderr.enqueue(chunk),
    );
    logsTask.catch(() => {});

    const winner = await Promise.race([
      logsTask.then(() => 'logs' as const),
      abortPromise,
    ]);
    if (winner === 'aborted') {
      await sandbox.process.deleteSession(sessionId).catch(() => {});
      return abortedExitInfo();
    }

    await logsTask;
    const code = await waitForSessionCommandExitCode({
      sandbox,
      sessionId,
      commandId,
      timeoutMs: sessionExitPollTimeoutMs(commandTimeout),
      isAborted: () => aborted,
    });
    return { code, signal: null, success: code === 0 };
  } catch (error) {
    if (aborted) return abortedExitInfo();
    const err = toError(error);
    stdout.error(err);
    stderr.error(err);
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abort);
    }
    stdout.close();
    stderr.close();
    if (sessionCreated) {
      await sandbox.process.deleteSession(sessionId).catch(() => {});
    }
  }
}

async function waitForSessionCommandExitCode(args: {
  sandbox: Sandbox;
  sessionId: string;
  commandId: string;
  timeoutMs: number;
  isAborted: () => boolean;
}): Promise<number> {
  const { sandbox, sessionId, commandId, timeoutMs, isAborted } = args;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (isAborted()) throw new DaytonaCommandError('Daytona command aborted.');

    const info = await sandbox.process.getSessionCommand(sessionId, commandId);
    if (typeof info.exitCode === 'number') {
      return info.exitCode;
    }

    if (Date.now() >= deadline) {
      throw new DaytonaCommandError(
        `Daytona session command "${commandId}" logs closed before an exit code became available.`,
      );
    }

    await delay(DAYTONA_EXIT_POLL_INTERVAL_MS);
  }
}

function sessionExitPollTimeoutMs(commandTimeout: number | undefined): number {
  if (commandTimeout === undefined || commandTimeout === 0) {
    return DAYTONA_EXIT_POLL_TIMEOUT_MS;
  }
  return Math.max(commandTimeout * 1000, DAYTONA_EXIT_POLL_TIMEOUT_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TextReadable {
  stream: ReadableStream<Uint8Array>;
  enqueue(chunk: string): void;
  close(): void;
  error(error: Error): void;
}

function createTextReadable(): TextReadable {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;

  return {
    stream: new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }),
    enqueue(chunk) {
      if (closed || !chunk) return;
      controller?.enqueue(encoder.encode(chunk));
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

function buildSessionCommand(command: string, options: SpawnOptions): string {
  const cwdPrefix = options.cwd ? `cd ${shellQuote(options.cwd)} && ` : '';
  const env = options.env ?? {};
  const entries = Object.entries(env);
  if (entries.length === 0) {
    return `sh -lc ${shellQuote(`${cwdPrefix}${command}`)}`;
  }

  for (const [key] of entries) {
    validateEnvKey(key);
  }

  const exports = entries
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  return `sh -lc ${shellQuote(`${exports}; ${cwdPrefix}${command}`)}`;
}

function validateEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new DaytonaSandboxError(
      `Invalid environment variable key: "${key}". Use shell-compatible environment variable names.`,
    );
  }
}

function createSessionId(kind: 'exec' | 'spawn'): string {
  return `deepagents-${kind}-${randomUUID()}`;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

function compactObject<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}

function isMissingDaytonaSdk(error: Error): boolean {
  const maybeCode = (error as Error & { code?: string }).code;
  return (
    maybeCode === 'ERR_MODULE_NOT_FOUND' ||
    maybeCode === 'MODULE_NOT_FOUND' ||
    error.message.includes('@daytona/sdk')
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
