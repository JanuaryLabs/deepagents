import type { ContainerSandboxError } from './container-sandbox-errors.ts';
import {
  ContainerCreationError,
  DockerNotAvailableError,
  DockerSandboxError,
  VolumeCreateError,
  VolumeInspectError,
  VolumePathError,
  VolumeRemoveError,
} from './docker-sandbox-errors.ts';
import type {
  DockerNamedVolume,
  DockerNetwork,
  DockerResources,
  DockerSandboxVolume,
  DockerSecurity,
} from './docker-sandbox.ts';

/**
 * Resolved per-run configuration handed to an engine's {@link ContainerEngine.runArgs}.
 * Fields mirror the strategy's resolved state so the engine stays a pure
 * arg-builder with no dependency on strategy internals.
 */
export interface DockerRunSpec {
  image: string;
  containerId: string;
  workdir: string;
  resources: DockerResources;
  security: DockerSecurity;
  network: DockerNetwork;
  env: Record<string, string>;
  volumes: DockerSandboxVolume[];
  command?: readonly string[] | null;
  platform?: string;
  runtime?: string;
  gpus?: string;
  devices: string[];
  init: boolean;
  labels: Record<string, string>;
  sysctls: Record<string, string>;
  entrypoint?: string;
}

/**
 * The CLI dialect seam. Captures everything that differs between container
 * runtimes (binary, arg flags, status parsing, error-string detection) so the
 * shared strategy can orchestrate any engine. The Apple `container` engine will
 * implement the same surface in a later phase.
 */
export interface ContainerErrorFactory {
  serviceNotAvailable(): ContainerSandboxError;
  creation(
    message: string,
    image: string,
    cause?: Error,
  ): ContainerSandboxError;
  generic(message: string, containerId?: string): ContainerSandboxError;
  volumePath(
    source: string,
    containerPath: string,
    reason: string,
  ): ContainerSandboxError;
  volumeInspect(name: string, reason: string): ContainerSandboxError;
  volumeCreate(name: string, reason: string): ContainerSandboxError;
  volumeRemove(name: string, reason: string): ContainerSandboxError;
}

export interface ContainerEngine {
  readonly cli: string;
  execArgs(
    containerId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): string[];
  inspectArgs(containerId: string): string[];
  mountArg(volume: DockerSandboxVolume): string;
  parseStatus(status: string): 'running' | 'stopped' | 'absent';
  volumeCreateArgs(volume: DockerNamedVolume): string[];
  errorMessage(error: unknown): string;
  isServiceDown(message: string): boolean;
  isMissingContainer(message: string): boolean;
  isMissingVolume(message: string): boolean;
  isNameConflict(message: string): boolean;
  readonly errors: ContainerErrorFactory;
}

/** Docker's engine adds `runArgs` (its `docker run` spec is Docker-specific). */
export interface DockerEngine extends ContainerEngine {
  runArgs(spec: DockerRunSpec): string[];
}

function dockerMountArg(volume: DockerSandboxVolume): string {
  const readOnly = volume.readOnly !== false;
  const parts =
    volume.type === 'bind'
      ? ['type=bind', `src=${volume.hostPath}`, `dst=${volume.containerPath}`]
      : [
          'type=volume',
          `src=${volume.name}`,
          `dst=${volume.containerPath}`,
          ...(volume.subPath ? [`volume-subpath=${volume.subPath}`] : []),
          ...(volume.noCopy ? ['volume-nocopy'] : []),
        ];

  if (readOnly) {
    parts.push('readonly');
  }

  return parts.join(',');
}

export const dockerEngine: DockerEngine = {
  cli: 'docker',

  runArgs(spec: DockerRunSpec): string[] {
    const {
      memory = '1g',
      cpus = 2,
      memorySwap,
      shmSize,
      pidsLimit,
      ulimits = [],
      cpusetCpus,
      cpuShares,
    } = spec.resources;

    const args: string[] = [
      'run',
      '-d',
      '--rm',
      '--name',
      spec.containerId,
      '--memory',
      memory,
      '--cpus',
      String(cpus),
      '-w',
      spec.workdir,
    ];

    if (memorySwap) {
      args.push('--memory-swap', memorySwap);
    }
    if (shmSize) {
      args.push('--shm-size', shmSize);
    }
    if (pidsLimit !== undefined) {
      args.push('--pids-limit', String(pidsLimit));
    }
    for (const ulimit of ulimits) {
      args.push('--ulimit', ulimit);
    }
    if (cpusetCpus) {
      args.push('--cpuset-cpus', cpusetCpus);
    }
    if (cpuShares !== undefined) {
      args.push('--cpu-shares', String(cpuShares));
    }

    if (spec.platform) {
      args.push('--platform', spec.platform);
    }
    if (spec.runtime) {
      args.push('--runtime', spec.runtime);
    }

    const security = spec.security;
    for (const cap of security.capDrop ?? []) {
      args.push('--cap-drop', cap);
    }
    for (const cap of security.capAdd ?? []) {
      args.push('--cap-add', cap);
    }
    if (security.readOnly) {
      args.push('--read-only');
    }
    if (security.user) {
      args.push('--user', security.user);
    }
    for (const mount of security.tmpfs ?? []) {
      args.push('--tmpfs', mount);
    }
    for (const opt of security.securityOpt ?? []) {
      args.push('--security-opt', opt);
    }

    const network = spec.network;
    if (network.mode) {
      args.push('--network', network.mode);
    }
    for (const port of network.publish ?? []) {
      args.push('--publish', port);
    }
    for (const server of network.dns ?? []) {
      args.push('--dns', server);
    }
    for (const host of network.addHost ?? []) {
      args.push('--add-host', host);
    }
    if (network.hostname) {
      args.push('--hostname', network.hostname);
    }

    if (spec.gpus) {
      args.push('--gpus', spec.gpus);
    }
    for (const device of spec.devices) {
      args.push('--device', device);
    }
    if (spec.init) {
      args.push('--init');
    }
    for (const [key, value] of Object.entries(spec.labels)) {
      args.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(spec.sysctls)) {
      args.push('--sysctl', `${key}=${value}`);
    }
    if (spec.entrypoint) {
      args.push('--entrypoint', spec.entrypoint);
    }

    for (const [key, value] of Object.entries(spec.env)) {
      args.push('-e', `${key}=${value}`);
    }

    for (const volume of spec.volumes) {
      args.push('--mount', dockerMountArg(volume));
    }

    args.push(spec.image);
    if (spec.command === undefined) {
      args.push('tail', '-f', '/dev/null');
    } else if (spec.command !== null) {
      args.push(...spec.command);
    }

    return args;
  },

  execArgs(
    containerId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string> },
  ): string[] {
    const flags: string[] = [];
    if (options?.cwd) {
      flags.push('-w', options.cwd);
    }
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        if (key.length === 0 || key.includes('=')) {
          throw new DockerSandboxError(
            `Invalid environment variable key: "${key}"`,
          );
        }
        flags.push('-e', `${key}=${value}`);
      }
    }
    return ['exec', ...flags, containerId, 'sh', '-c', command];
  },

  inspectArgs(containerId: string): string[] {
    return [
      'container',
      'inspect',
      '--format',
      '{{.State.Status}}',
      containerId,
    ];
  },

  mountArg: dockerMountArg,

  parseStatus(status: string): 'running' | 'stopped' | 'absent' {
    return status === 'running' ? 'running' : 'stopped';
  },

  volumeCreateArgs(volume: DockerNamedVolume): string[] {
    const args = ['volume', 'create'];
    if (volume.driver) {
      args.push('--driver', volume.driver);
    }
    for (const [key, value] of Object.entries(volume.driverOptions ?? {})) {
      args.push('--opt', `${key}=${value}`);
    }
    args.push(volume.name);
    return args;
  },

  errorMessage(error: unknown): string {
    const err = error as Error & { stderr?: string; stdout?: string };
    return err.stderr || err.stdout || err.message || String(error);
  },

  isServiceDown(message: string): boolean {
    return (
      message.includes('Cannot connect') || message.includes('docker daemon')
    );
  },

  isMissingContainer(message: string): boolean {
    return message.toLowerCase().includes('no such container');
  },

  isMissingVolume(message: string): boolean {
    return message.toLowerCase().includes('no such volume');
  },

  isNameConflict(message: string): boolean {
    return message.toLowerCase().includes('is already in use by container');
  },

  errors: {
    serviceNotAvailable: () => new DockerNotAvailableError(),
    creation: (message, image, cause) =>
      new ContainerCreationError(message, image, cause),
    generic: (message, containerId) =>
      new DockerSandboxError(message, containerId),
    volumePath: (source, containerPath, reason) =>
      new VolumePathError(source, containerPath, reason),
    volumeInspect: (name, reason) => new VolumeInspectError(name, reason),
    volumeCreate: (name, reason) => new VolumeCreateError(name, reason),
    volumeRemove: (name, reason) => new VolumeRemoveError(name, reason),
  },
};
