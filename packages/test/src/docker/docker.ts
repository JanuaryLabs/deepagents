import spawn, { SubprocessError } from 'nano-spawn';
import { createHash, randomUUID } from 'node:crypto';

import { Container } from './container.ts';

export interface ContainerOptions {
  image: string;
  internalPort: number;
  /** Owned starts generate a name; reuse derives it from configuration. */
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  tmpfs?: string[];
  ipcHost?: boolean;
  memorySwappiness?: number;
  /** Runs on every acquisition. Throw until ready, using timebox for polling. */
  healthy?: (container: Container) => unknown;
}

interface InspectedContainer {
  Id: string;
  Config: { Labels: Record<string, string> | null };
  State: { Status: string };
}

/** Docker owns cross-process coordination; this instance holds no server cache. */
export class Docker {
  #availability: Promise<boolean> | undefined;

  isAvailable(): Promise<boolean> {
    return (this.#availability ??= this.#probe());
  }

  async #probe(): Promise<boolean> {
    try {
      await spawn('docker', ['info']);
      return true;
    } catch {
      return false;
    }
  }

  async #require(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new Error('Docker is required for container-backed tests');
    }
  }

  /** Create a dedicated container. Failure or disposal stops this container. */
  async start(options: ContainerOptions): Promise<Container> {
    await this.#require();
    const name =
      options.name ??
      `test-${options.image.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID()}`;
    const { stdout, stderr } = await spawn('docker', [
      'run',
      '-d',
      ...this.#args({ ...options, name }),
    ]);
    const id = stdout.trim();
    if (!id) throw new Error(`Failed to start container: ${stderr}`);
    try {
      const container = await this.#handle(id, options.internalPort);
      await options.healthy?.(container);
      return container;
    } catch (error) {
      await spawn('docker', ['stop', id]).catch(() => {});
      throw error;
    }
  }

  /**
   * Reuse one server per configuration on this daemon, across processes/runs.
   * Docker reserves the name atomically. Readiness failure leaves it running.
   * Only explicitly dispose the returned container after all its users finish.
   */
  async reuse(options: ContainerOptions): Promise<Container> {
    await this.#require();
    const fingerprint = this.#fingerprint(options);
    const name = options.name ?? `deepagents-test-${fingerprint}`;
    let inspected = await this.#inspect(name);
    if (!inspected) {
      try {
        await spawn('docker', [
          'create',
          ...this.#args({
            ...options,
            name,
            labels: {
              ...options.labels,
              'dev.deepagents.test.shared': '1',
              'dev.deepagents.test.config': fingerprint,
            },
          }),
        ]);
      } catch (error) {
        if (
          !(error instanceof SubprocessError) ||
          !error.stderr.includes('is already in use by container')
        )
          throw error;
      }
      inspected = await this.#inspect(name);
    }
    if (
      !inspected ||
      inspected.Config.Labels?.['dev.deepagents.test.shared'] !== '1' ||
      inspected.Config.Labels['dev.deepagents.test.config'] !== fingerprint
    ) {
      throw new Error(
        `Container ${name} is missing or does not match the shared test configuration`,
      );
    }
    if (inspected.State.Status !== 'running') {
      await spawn('docker', ['start', inspected.Id]);
    }
    const container = await this.#handle(inspected.Id, options.internalPort);
    await options.healthy?.(container);
    return container;
  }

  #fingerprint(options: ContainerOptions): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          image: options.image,
          internalPort: options.internalPort,
          env: Object.entries(options.env ?? {}).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
          labels: Object.entries(options.labels ?? {}).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
          tmpfs: options.tmpfs ?? [],
          ipcHost: Boolean(options.ipcHost),
          memorySwappiness: options.memorySwappiness,
        }),
      )
      .digest('hex');
  }

  #args(options: ContainerOptions & { name: string }): string[] {
    const args = ['--rm', '--name', options.name];
    for (const [key, value] of Object.entries(options.labels ?? {})) {
      args.push('--label', `${key}=${value}`);
    }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    for (const spec of options.tmpfs ?? []) args.push('--tmpfs', spec);
    if (options.ipcHost) args.push('--ipc=host');
    if (options.memorySwappiness !== undefined) {
      args.push(`--memory-swappiness=${options.memorySwappiness}`);
    }
    return [...args, '-P', options.image];
  }

  async #inspect(name: string): Promise<InspectedContainer | undefined> {
    try {
      const { stdout } = await spawn('docker', ['container', 'inspect', name]);
      const [container]: InspectedContainer[] = JSON.parse(stdout);
      return container;
    } catch (error) {
      if (
        error instanceof SubprocessError &&
        /No such (object|container):/i.test(error.stderr)
      )
        return undefined;
      throw error;
    }
  }

  async #handle(id: string, internalPort: number): Promise<Container> {
    const { stdout } = await spawn('docker', [
      'port',
      id,
      String(internalPort),
    ]);
    const match = stdout.trim().match(/:(\d+)$/);
    if (!match)
      throw new Error(
        `Failed to get mapped port for container ${id}: ${stdout}`,
      );
    return new Container(id, Number.parseInt(match[1], 10));
  }
}
