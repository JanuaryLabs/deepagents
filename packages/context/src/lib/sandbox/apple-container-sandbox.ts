import type { Experimental_SandboxFileStat } from '@ai-sdk/provider-utils';
import { TemporaryFiles } from '@zukhruf/fs';
import spawn, { SubprocessError } from 'nano-spawn';
import {
  type ChildProcessWithoutNullStreams,
  spawn as childSpawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import z from 'zod';

import {
  AppleContainerCreationError,
  AppleContainerImageBuildError,
  AppleContainerSandboxError,
  AppleContainerVolumeCreateError,
  AppleContainerVolumeInspectError,
  AppleContainerVolumePathError,
  AppleContainerVolumeRemoveError,
  ContainerServiceNotRunningError,
} from './apple-container-sandbox-errors.ts';
import type {
  ChatContainerEngine,
  ChatEngineContainer,
  EngineContainer,
  EngineExecOptions,
  EngineProcess,
  EngineProcessOptions,
  EngineSpawnOptions,
  ImageBuildSpec,
  SandboxVolume,
} from './container-engine.ts';
import { ContainerfileStrategy, RuntimeStrategy } from './container-sandbox.ts';
import {
  chatContainerSandbox,
  collectOutput,
  readFileOverExec,
  statOverExec,
  validateEnv,
  writeFileOverExec,
} from './container-session.ts';
import {
  type Installer,
  type InstallerContext,
  createInstallerContext,
} from './installers/installer.ts';
import {
  chatSandboxLabels,
  chatSandboxName,
  createByteReadable,
} from './session.ts';
import { shellQuote } from './shell-quote.ts';
import {
  type ChatSandbox,
  type CommandResult,
  type DisposableSandbox,
  type SandboxContext,
  SandboxNotFoundError,
  type SandboxReadinessOptions,
  type StoppableSandboxEnvironment,
} from './types.ts';

export {
  AppleContainerCreationError,
  AppleContainerImageBuildError,
  AppleContainerSandboxError,
  AppleContainerVolumeCreateError,
  AppleContainerVolumeInspectError,
  AppleContainerVolumePathError,
  AppleContainerVolumeRemoveError,
  ContainerServiceNotRunningError,
} from './apple-container-sandbox-errors.ts';

const CLI = 'container';

/** Working directory every sandbox command runs in, mirroring the Docker backend. */
const WORKDIR = '/workspace';

export interface AppleContainerBindVolume {
  type: 'bind';
  hostPath: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
}

export interface AppleContainerNamedVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  /** Default: `'external'`. */
  lifecycle?: 'external' | 'managed';
  /** Default: `true` for managed volumes created by this sandbox. */
  removeOnDispose?: boolean;
}

/**
 * Apple `container` volumes are always local ext4 disk images — there is no
 * pluggable driver model (unlike Docker's `--driver`). Back a volume with
 * remote storage by bind-mounting a host directory instead.
 */
export type AppleContainerVolume =
  AppleContainerBindVolume | AppleContainerNamedVolume;

/** A named volume that exists before the container. The sandbox never creates or removes it. */
export interface AppleContainerExternalVolume {
  type: 'volume';
  name: string;
  containerPath: string;
  /** Default: `true`. */
  readOnly?: boolean;
  lifecycle?: 'external';
}

/** What a chat's container mounts: its durable files live in volumes the host provides. */
export type AppleContainerChatVolume =
  AppleContainerBindVolume | AppleContainerExternalVolume;

export interface AppleContainerResources {
  /** `--memory` — e.g. `'1024M'`, `'2G'` (MB granularity). */
  memory?: string;
  /** `--cpus` — number of CPUs. */
  cpus?: number;
}

export interface AppleContainerCommonOptions {
  volumes?: AppleContainerVolume[];
  resources?: AppleContainerResources;
  /** DNS nameservers passed to `container run --dns`. */
  dns?: readonly string[];
  env?: Record<string, string>;
  /**
   * Args appended after the image at `container run` time.
   * - `undefined` (default): `['tail', '-f', '/dev/null']` keep-alive so a bare
   *   image stays up for installers and commands.
   * - `[]` or `null`: nothing appended; the image's own `CMD`/`ENTRYPOINT` runs.
   * - A non-empty array: appended verbatim, overriding the image command.
   */
  command?: readonly string[] | null;
  /**
   * `-a, --arch` — `'arm64'` (native on Apple silicon) or `'amd64'` (emulated
   * via Rosetta). Replaces the Docker backend's `--platform`.
   */
  arch?: 'arm64' | 'amd64';
}

export interface AppleContainerRuntimeOptions extends AppleContainerCommonOptions {
  /** Image to run (default: `'docker.io/library/bash:5.3-alpine3.24'`). */
  image?: string;
  /**
   * Ordered installers run after the container starts. Use `pkg([...])`,
   * `urlBinary({...})`, `npm(...)`, `pip(...)`, `githubRelease({...})`, or any
   * custom `Installer` — the same installers the Docker backend accepts.
   */
  installers?: Installer[];
}

export interface AppleContainerfileOptions extends AppleContainerCommonOptions {
  /** Inline Dockerfile content (contains `\n`) or a path to one. */
  dockerfile: string;
  /** Build context directory (default: `'.'`). */
  context?: string;
  /** Stream `container build` output instead of buffering it. Default `false`. */
  showBuildLogs?: boolean;
}

export type AppleContainerSandboxOptions =
  AppleContainerRuntimeOptions | AppleContainerfileOptions;

export function isAppleContainerfileOptions(
  opts: AppleContainerSandboxOptions,
): opts is AppleContainerfileOptions {
  return 'dockerfile' in opts;
}

function buildMountArg(volume: SandboxVolume): string {
  const readOnly = volume.readOnly !== false;
  if (volume.type === 'volume') {
    // Named volumes use `-v name:path[:ro]` — the one syntax every CLI version
    // accepts: pre-1.0 rejects `--mount type=volume` ("unknown mount type")
    // and 1.0.0 rejects `type=virtiofs,source=<name>` (source became a host
    // path). Pair with the `-v/--volume` flag, not `--mount`.
    return `${volume.name}:${volume.containerPath}${readOnly ? ':ro' : ''}`;
  }
  const parts = [
    'type=bind',
    `source=${volume.hostPath}`,
    `target=${volume.containerPath}`,
  ];
  if (readOnly) {
    parts.push('readonly');
  }
  return parts.join(',');
}

function getCliErrorMessage(error: unknown): string {
  if (error instanceof SubprocessError) {
    return error.stderr.trim() || error.stdout.trim() || error.message;
  }
  return (Error.isError(error) && error.message) || String(error);
}

function safeParseArray(stdout: string): unknown[] {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One `container inspect` entry. CLI 1.0.0 nests the state in a `status`
 * object; pre-1.0 returned a bare string ("booted" was a pre-1.0 transient
 * right after `run --detach`).
 */
const containerInspectEntry = z.object({
  status: z.union([
    z.string(),
    z.object({ state: z.string() }).transform(({ state }) => state),
  ]),
});

function readContainerStatus(entry: unknown): 'running' | 'stopped' {
  const parsed = containerInspectEntry.safeParse(entry);
  const status = parsed.success ? parsed.data.status.toLowerCase() : '';
  // "running"/"booted" are up. "stopped" is the only state `container start`
  // accepts. Fail loud on anything else (error/exited/…) rather than opening
  // a broken container.
  if (status === 'running' || status === 'booted') return 'running';
  if (status === 'stopped') return 'stopped';
  throw new AppleContainerSandboxError(
    `Container is in an unexpected state "${status}"`,
  );
}

function isServiceDown(message: string): boolean {
  return /apiserver|not running|connection refused|could not connect|xpc/i.test(
    message,
  );
}

function isMissing(message: string): boolean {
  return /not found|no such/i.test(message);
}

/**
 * Each verb names a missing container its own way: `inspect` says "container
 * not found: <name>", `stop`, `delete` and `start` say "container with ID
 * <name> not found", and `exec` says "container <name> not found".
 */
function isMissingContainer(message: string): boolean {
  return /container (?:not found|with ID \S+ not found|\S+ not found)/.test(
    message,
  );
}

function isNameConflict(message: string): boolean {
  return /already exists/i.test(message);
}

/**
 * A pipe of the child as a web stream that drains it to the end, also after a
 * reader cancels: the child then never writes into a closed pipe, so its exit
 * stays the command's.
 */
function drained(pipe: Readable): ReadableStream<Uint8Array> {
  const readable = createByteReadable();
  pipe.on('data', (chunk: Buffer) => readable.enqueue(chunk));
  pipe.once('end', () => readable.close());
  pipe.once('error', (error) => readable.error(error));
  return readable.stream;
}

function engineProcess(child: ChildProcessWithoutNullStreams): EngineProcess {
  return {
    stdout: drained(child.stdout),
    stderr: drained(child.stderr),
    exitCode: once(child, 'close').then(([code]) => code ?? 1),
  };
}

/** A sandbox container of the Apple `container` runtime. */
class AppleContainer implements EngineContainer {
  readonly name: string;
  readonly workdir = WORKDIR;

  constructor(name: string) {
    this.name = name;
  }

  async exec(
    argv: string[],
    { stdin, ...options }: EngineExecOptions = {},
  ): Promise<CommandResult> {
    try {
      const child = this.#exec(argv, options, stdin !== undefined);
      // A command can end before it reads its input: the result tells why.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
      return await collectOutput(engineProcess(child));
    } catch (error) {
      return {
        stdout: '',
        stderr: Error.isError(error) ? error.message : String(error),
        exitCode: 1,
      };
    }
  }

  async spawn(
    argv: string[],
    { stdin, ...options }: EngineSpawnOptions,
  ): Promise<EngineProcess> {
    const child = this.#exec(argv, options, stdin === true);
    if (stdin) {
      return { ...engineProcess(child), stdin: Writable.toWeb(child.stdin) };
    }
    child.stdin.end();
    return engineProcess(child);
  }

  #exec(
    argv: string[],
    {
      workingDirectory = WORKDIR,
      env = {},
      signal,
    }: EngineProcessOptions & { signal?: AbortSignal },
    interactive: boolean,
  ) {
    return childSpawn(
      CLI,
      [
        'exec',
        ...(interactive ? ['--interactive'] : []),
        '--cwd',
        workingDirectory,
        ...Object.entries(env).flatMap(([key, value]) => [
          '--env',
          `${key}=${value}`,
        ]),
        this.name,
        ...argv,
      ],
      // The CLI traps SIGTERM and exits 0, which would read as a success.
      { signal, killSignal: 'SIGKILL' },
    );
  }

  readFile(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | null> {
    return readFileOverExec(this, path, signal);
  }

  stat(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Experimental_SandboxFileStat | null> {
    return statOverExec(this, path, signal);
  }

  writeFile(
    path: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return writeFileOverExec(this, path, content, signal);
  }

  installerContext(image: string): InstallerContext {
    // The Docker installer suite, driven through `container exec`.
    return createInstallerContext(
      {
        exec: (command) => this.exec(['sh', '-c', command]),
        SandboxError: AppleContainerSandboxError,
      },
      this.name,
      image,
    );
  }

  /** A call of the CLI reaches the container by name, and reads its absence as a failed command. */
  async assertCurrent(): Promise<void> {
    if ((await inspectContainer(this.name)) === undefined) {
      throw new SandboxNotFoundError(this.name);
    }
  }

  stop(): Promise<void> {
    return endContainer(['stop'], this.name);
  }
}

/**
 * The label that tells a chat's container from another that later takes its
 * name: the CLI reaches containers by name only, and gives them no other id.
 */
const INSTANCE_LABEL = 'deepagents.sandbox.instance';

const chatInspectEntry = z.object({
  configuration: z.object({
    labels: z.record(z.string(), z.string()).optional(),
  }),
});

/** The container named `name` as the CLI reports it; `undefined` when there is none. */
async function inspectContainer(
  name: string,
): Promise<
  { state: 'running' | 'stopped'; instance: string | undefined } | undefined
> {
  let stdout: string;
  try {
    ({ stdout } = await spawn(CLI, ['inspect', name]));
  } catch (error) {
    const message = getCliErrorMessage(error);
    if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
    if (isMissingContainer(message)) return undefined;
    throw new AppleContainerSandboxError(
      `Failed to inspect container "${name}": ${message}`,
      name,
    );
  }
  const [entry] = safeParseArray(stdout.trim());
  if (entry === undefined) return undefined;
  const parsed = chatInspectEntry.safeParse(entry);
  return {
    state: readContainerStatus(entry),
    instance: parsed.data?.configuration.labels?.[INSTANCE_LABEL],
  };
}

/** `container stop` or `container delete --force`, resolving when the container is not there. */
async function endContainer(
  args: ['stop' | 'delete', ...string[]],
  name: string,
): Promise<void> {
  try {
    await spawn(CLI, [...args, name]);
  } catch (error) {
    const message = getCliErrorMessage(error);
    if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
    if (isMissingContainer(message)) return;
    throw new AppleContainerSandboxError(
      `Failed to ${args[0]} container "${name}": ${message}`,
      name,
    );
  }
}

/** The container of a chat, which the service keeps when it stops. */
class AppleChatContainer extends AppleContainer implements ChatEngineContainer {
  readonly #instance: string | undefined;

  constructor(name: string, instance: string | undefined) {
    super(name);
    this.#instance = instance;
  }

  /** The state of the container that has the name, when it is this one. */
  async #state(): Promise<'running' | 'stopped'> {
    const found = await inspectContainer(this.name);
    if (found === undefined || found.instance !== this.#instance) {
      throw new SandboxNotFoundError(this.name);
    }
    return found.state;
  }

  override async assertCurrent(): Promise<void> {
    await this.#state();
  }

  /** The service has no paused state: a container runs or is stopped. */
  async resume(): Promise<void> {
    if ((await this.#state()) === 'running') return;
    try {
      await spawn(CLI, ['start', this.name]);
    } catch (error) {
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      if (isMissingContainer(message)) {
        throw new SandboxNotFoundError(this.name, { cause: error });
      }
      throw new AppleContainerSandboxError(
        `Failed to start container "${this.name}": ${message}`,
        this.name,
      );
    }
  }

  remove(): Promise<void> {
    return endContainer(['delete', '--force'], this.name);
  }
}

/** The run flags a one-off and a chat container share: resources, env and mounts. */
function containerFlags(opts: AppleContainerCommonOptions): string[] {
  const { memory, cpus } = opts.resources ?? {};
  const args: string[] = [];
  if (memory) {
    args.push('--memory', memory);
  }
  if (cpus !== undefined) {
    args.push('--cpus', String(cpus));
  }
  if (opts.arch) {
    args.push('--arch', opts.arch);
  }
  for (const nameserver of opts.dns ?? []) {
    args.push('--dns', nameserver);
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  for (const volume of opts.volumes ?? []) {
    args.push(
      volume.type === 'volume' ? '--volume' : '--mount',
      buildMountArg(volume),
    );
  }
  return args;
}

/** What runs after the image: the keep-alive unless the caller gives a command. */
function commandArgs(opts: AppleContainerCommonOptions): readonly string[] {
  if (opts.command === undefined) return ['tail', '-f', '/dev/null'];
  return opts.command ?? [];
}

/**
 * The Apple `container` CLI dialect, plugged into the shared
 * `ContainerSandboxStrategy` skeleton: `--cwd`/`--env` exec flags, JSON
 * `inspect` parsing, virtiofs mounts, `apiserver`-down detection, and Apple
 * error classes. `runArgs` is its argv dialect.
 */
export const appleEngine: ChatContainerEngine<AppleContainerCommonOptions> & {
  runArgs(
    image: string,
    containerId: string,
    opts: AppleContainerCommonOptions,
    workdir: string,
  ): string[];
} = {
  bindMountsOnClient: true,
  defaultImage: 'docker.io/library/bash:5.3-alpine3.24',

  runArgs(image, containerId, opts) {
    return [
      'run',
      '--detach',
      '--rm',
      '--name',
      containerId,
      ...containerFlags(opts),
      image,
      ...commandArgs(opts),
    ];
  },

  async find(name) {
    const found = await inspectContainer(name);
    return found && new AppleChatContainer(name, found.instance);
  },

  /**
   * `container create`, then `container start`: a `run` that loses a race
   * for the name stops the winner's container, while a losing `create`
   * leaves it alone. `--workdir` makes the directory at once, so a caller
   * that lost the race can run in it before the creator configured it.
   */
  async createChat(image, name, opts, workdir, labels) {
    const instance = randomUUID();
    try {
      await spawn(CLI, [
        'create',
        '--init',
        '--name',
        name,
        '--workdir',
        workdir,
        ...Object.entries({ ...labels, [INSTANCE_LABEL]: instance }).flatMap(
          ([key, value]) => ['--label', `${key}=${value}`],
        ),
        ...containerFlags(opts),
        image,
        ...commandArgs(opts),
      ]);
    } catch (error) {
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      if (!isNameConflict(message)) {
        throw new AppleContainerCreationError(
          message,
          image,
          Error.isError(error) ? error : undefined,
        );
      }
      const winner = await this.find(name);
      if (winner) return { created: false, container: winner };
      // The winner was deleted before it could be found: create it again.
      return this.createChat(image, name, opts, workdir, labels);
    }
    const container = new AppleChatContainer(name, instance);
    try {
      await spawn(CLI, ['start', name]);
    } catch (error) {
      await container.remove();
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      throw new AppleContainerCreationError(
        message,
        image,
        Error.isError(error) ? error : undefined,
      );
    }
    return { created: true, container };
  },

  async run(image, name, opts, workdir) {
    try {
      await spawn(CLI, this.runArgs(image, name, opts, workdir));
    } catch (error) {
      const message = getCliErrorMessage(error);
      if (isServiceDown(message)) throw new ContainerServiceNotRunningError();
      if (isNameConflict(message)) return { created: false };
      throw new AppleContainerCreationError(
        message,
        image,
        Error.isError(error) ? error : undefined,
      );
    }
    return { created: true, container: new AppleContainer(name) };
  },

  async volumeExists(name) {
    try {
      await spawn(CLI, ['volume', 'inspect', name]);
      return true;
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      if (isMissing(reason)) return false;
      throw new AppleContainerVolumeInspectError(name, reason);
    }
  },

  async createVolume(volume) {
    try {
      await spawn(CLI, ['volume', 'create', volume.name]);
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      throw new AppleContainerVolumeCreateError(volume.name, reason);
    }
  },

  async removeVolume(name) {
    try {
      await spawn(CLI, ['volume', 'rm', name]);
    } catch (error) {
      const reason = getCliErrorMessage(error);
      if (isServiceDown(reason)) throw new ContainerServiceNotRunningError();
      throw new AppleContainerVolumeRemoveError(name, reason);
    }
  },

  async ensureWorkdir(container, workdir) {
    // `container exec --cwd <dir>` fails if <dir> is absent, so the workdir
    // can't be created from inside itself — bootstrap it from the image's
    // default cwd with a plain (no `--cwd`) exec.
    await spawn(CLI, [
      'exec',
      container.name,
      'bash',
      '-lc',
      `mkdir -p ${shellQuote(workdir)}`,
    ]);
  },

  async imageExists(tag: string): Promise<boolean> {
    try {
      await spawn(CLI, ['image', 'inspect', tag]);
      return true;
    } catch {
      return false;
    }
  },

  async buildImage(spec: ImageBuildSpec): Promise<void> {
    const archFlag = spec.identity ? ['--arch', spec.identity] : [];
    // `container build` has no `-f -` (stdin) mode, so an inline Dockerfile is
    // written to a fresh temp dir that doubles as a minimal build context
    // (a real directory — `container build` rejects the `/tmp` symlink).
    if (spec.dockerfile.includes('\n')) {
      await using tempDir = await new TemporaryFiles().directory(
        'sandbox-containerfile-',
      );
      const dockerfilePath = join(tempDir.path, 'Dockerfile');
      await writeFile(dockerfilePath, spec.dockerfile);
      await runAppleBuild(
        [
          'build',
          ...archFlag,
          '-t',
          spec.tag,
          '-f',
          dockerfilePath,
          tempDir.path,
        ],
        spec.showBuildLogs,
      );
      return;
    }
    await runAppleBuild(
      [
        'build',
        ...archFlag,
        '-t',
        spec.tag,
        '-f',
        spec.dockerfile,
        spec.context,
      ],
      spec.showBuildLogs,
    );
  },

  async dispose() {
    // The CLI holds no connection.
  },

  errors: {
    generic: (message, containerId) =>
      new AppleContainerSandboxError(message, containerId),
    volumePath: (source, containerPath, reason) =>
      new AppleContainerVolumePathError(source, containerPath, reason),
    volumeInspect: (name, reason) =>
      new AppleContainerVolumeInspectError(name, reason),
    volumeCreate: (name, reason) =>
      new AppleContainerVolumeCreateError(name, reason),
  },
};

async function runAppleBuild(
  args: string[],
  showBuildLogs: boolean,
): Promise<void> {
  try {
    await spawn(CLI, args, showBuildLogs ? { stdio: 'inherit' } : {});
  } catch (error) {
    // nano-spawn names a CLI that could not start only in the cause.
    throw new AppleContainerImageBuildError(
      getCliErrorMessage(
        error instanceof SubprocessError ? (error.cause ?? error) : error,
      ),
    );
  }
}

/** What a chat environment takes beside a backend's options. */
interface AppleContainerChatOptions extends SandboxReadinessOptions {
  /**
   * With a chat's id, names that chat's container. Two environments with the
   * same namespace on one machine reach the same containers; give each app or
   * deployment its own.
   */
  namespace: string;
  /**
   * The volumes of a chat's container, given when `open` creates it. Its
   * durable files belong here: the rest is lost when the container is deleted.
   */
  volumes?: (chat: SandboxContext) => AppleContainerChatVolume[];
}

type AppleChatEnvironmentBase<T extends AppleContainerCommonOptions> = Omit<
  T,
  'volumes'
> &
  AppleContainerChatOptions;

/**
 * The options of an {@link AppleContainerSandboxEnvironment}: an image, or a
 * Dockerfile that builds one. A chat container has no installers: a second
 * worker could attach to it before they finish, so what it needs belongs in
 * its image.
 */
export type AppleContainerSandboxEnvironmentOptions =
  | (AppleChatEnvironmentBase<
      Omit<AppleContainerRuntimeOptions, 'installers'>
    > & { dockerfile?: never })
  | (AppleChatEnvironmentBase<AppleContainerfileOptions> & { image?: never });

/**
 * Chat containers on Apple's `container` service. A chat's container is named
 * from the namespace and the chat's id, and carries the labels
 * `deepagents.sandbox.namespace` and `deepagents.sandbox.chat`. It has no
 * `--rm`, so `stop` (`container stop`) keeps it and its files, and the next
 * `open` or `resume` starts it; `delete` is `container delete --force`. Its
 * PID 1 is the service's init, which reaps what killed commands leave behind.
 * The CLI holds no connection, so `close` releases nothing. Every operation
 * of a handle first checks that the container with the name is still the
 * one it opened, since the CLI reaches a container by name only.
 */
export class AppleContainerSandboxEnvironment implements StoppableSandboxEnvironment {
  readonly #options: AppleContainerSandboxEnvironmentOptions;

  constructor(options: AppleContainerSandboxEnvironmentOptions) {
    validateEnv(options.env, appleEngine.errors);
    this.#options = options;
  }

  #strategy(chat: SandboxContext) {
    const { volumes, ...options } = this.#options;
    const opts = { ...options, volumes: volumes?.(chat) ?? [] };
    if (options.dockerfile !== undefined) {
      return new ContainerfileStrategy(opts, appleEngine, {
        dockerfile: options.dockerfile,
        context: options.context ?? '.',
        showBuildLogs: options.showBuildLogs ?? false,
        identity: options.arch,
      });
    }
    return new RuntimeStrategy(opts, appleEngine, {
      image: options.image ?? appleEngine.defaultImage,
      installers: [],
    });
  }

  #name(chat: SandboxContext): string {
    return chatSandboxName(this.#options.namespace, chat);
  }

  async open(chat: SandboxContext): Promise<ChatSandbox> {
    const container = await this.#strategy(chat).openChat(
      this.#name(chat),
      chatSandboxLabels(this.#options.namespace, chat),
    );
    const sandbox = chatContainerSandbox(
      container,
      appleEngine.errors,
      chat.chatId,
      async () => {},
    );
    if (this.#options.readiness) {
      try {
        await this.#options.readiness(sandbox);
      } catch (error) {
        await sandbox.close();
        throw error;
      }
    }
    return sandbox;
  }

  /** `container stop`: the init passes the SIGTERM on, so it ends at once. */
  stop(chat: SandboxContext): Promise<void> {
    return endContainer(['stop'], this.#name(chat));
  }

  /** `container delete --force`; named volumes stay. */
  delete(chat: SandboxContext): Promise<void> {
    return endContainer(['delete', '--force'], this.#name(chat));
  }
}

/**
 * Create a one-off sandbox backed by Apple's `container` CLI — Linux
 * containers run as lightweight per-container virtual machines on Apple
 * silicon (macOS 26+). The container has a generated name, which nothing else
 * reaches. `dispose()` stops and removes it, and every operation rejects once
 * `dispose()` is called. A container that outlives the process is a chat's,
 * from an {@link AppleContainerSandboxEnvironment}.
 *
 * Requires the `container` service to be running (`container system start`)
 * with a guest kernel configured (`container system kernel set --recommended`).
 *
 * @example Runtime with installers
 * ```ts
 * import { createAppleContainerSandbox, pkg } from '@deepagents/context';
 *
 * await using sandbox = await createAppleContainerSandbox({
 *   image: 'docker.io/library/bash:5.3-alpine3.24',
 *   installers: [pkg(['curl', 'jq'])],
 * });
 * const { stdout } = await sandbox.run({ command: 'echo hello' });
 * ```
 *
 * @example Dockerfile
 * ```ts
 * await using sandbox = await createAppleContainerSandbox({
 *   dockerfile: `
 *     FROM docker.io/library/bash:5.3-alpine3.24
 *     RUN apk add --no-cache curl
 *   `,
 * });
 * ```
 */
export async function createAppleContainerSandbox(
  options: AppleContainerSandboxOptions = {},
): Promise<DisposableSandbox> {
  if (isAppleContainerfileOptions(options)) {
    return new ContainerfileStrategy(options, appleEngine, {
      dockerfile: options.dockerfile,
      context: options.context ?? '.',
      showBuildLogs: options.showBuildLogs ?? false,
      identity: options.arch,
    }).create();
  }
  return new RuntimeStrategy(options, appleEngine, {
    image: options.image ?? appleEngine.defaultImage,
    installers: options.installers ?? [],
  }).create();
}

/**
 * Run a function with an Apple container sandbox; the container is disposed on
 * completion (success or thrown).
 */
export async function useAppleContainerSandbox<T>(
  options: AppleContainerSandboxOptions,
  fn: (sandbox: DisposableSandbox) => Promise<T>,
): Promise<T> {
  await using sandbox = await createAppleContainerSandbox(options);

  return await fn(sandbox);
}
