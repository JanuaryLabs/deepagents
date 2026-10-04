import { SubprocessError } from 'nano-spawn';
import { createHash, randomUUID } from 'node:crypto';

import { timebox } from '../async/timebox.ts';
import { Container } from './container.ts';
import { DockerDirectory } from './directory.ts';
import { DockerHost } from './host.ts';

export interface ContainerOptions {
  image: string;
  internalPort: number;
  /** Owned starts generate a name; reuse derives it from configuration. */
  name?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  tmpfs?: string[];
  ipcHost?: boolean;
  memory?: string;
  cpus?: number;
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
  #host: Promise<DockerHost> | undefined;
  #failure: unknown;

  /** Defaults for disposable test containers, including external launchers. */
  get defaults(): {
    resources: { memory: string; cpus: number };
    labels: Record<string, string>;
  } {
    return {
      resources: { memory: '1g', cpus: 1 },
      labels: process.env.DEEPAGENTS_TEST_RUN_ID
        ? { 'dev.deepagents.test.run': process.env.DEEPAGENTS_TEST_RUN_ID }
        : {},
    };
  }

  #connection(): Promise<DockerHost> {
    return (this.#host ??= DockerHost.resolve());
  }

  async info(): Promise<{ architecture: string; endpoint: string }> {
    const host = await this.#connection();
    const { stdout } = await host.command([
      'info',
      '--format',
      '{{.Architecture}}',
    ]);
    return { architecture: stdout.trim(), endpoint: host.endpoint };
  }

  async directory(): Promise<DockerDirectory> {
    return DockerDirectory.create(await this.#connection());
  }

  readonly command = async (args: string[]) =>
    (await this.#connection()).command(args);

  isAvailable(): Promise<boolean> {
    return (this.#availability ??= this.#probe());
  }

  async #probe(): Promise<boolean> {
    try {
      await this.command(['info']);
      return true;
    } catch (error) {
      this.#failure = error;
      return false;
    }
  }

  async #require(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new Error('Docker is required for container-backed tests', {
        cause: this.#failure,
      });
    }
  }

  /** Create a dedicated container. Failure or disposal stops this container. */
  async start(options: ContainerOptions): Promise<Container> {
    await this.#require();
    const name =
      options.name ??
      `test-${options.image.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomUUID()}`;
    const { stdout, stderr } = await this.command([
      'run',
      '-d',
      ...this.#args({
        ...options,
        name,
        labels: {
          ...options.labels,
          ...this.defaults.labels,
        },
      }),
    ]);
    const id = stdout.trim();
    if (!id) throw new Error(`Failed to start container: ${stderr}`);
    try {
      const container = await this.#handle(id, options.internalPort);
      try {
        await options.healthy?.(container);
        return container;
      } catch (error) {
        await container.disconnect();
        throw error;
      }
    } catch (error) {
      await this.command(['stop', id]).catch(() => {});
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
        await this.command([
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
      // A competing create reserves the name before Docker registers it for
      // inspection. Retry only that absence, not daemon or permission errors.
      const pending = new Error(`Container ${name} is not visible yet`);
      inspected = await timebox(
        async () => {
          const container = await this.#inspect(name);
          if (!container) throw pending;
          return container;
        },
        { shouldRetry: ({ error }) => error === pending },
      );
    }
    if (
      inspected.Config.Labels?.['dev.deepagents.test.shared'] !== '1' ||
      inspected.Config.Labels['dev.deepagents.test.config'] !== fingerprint
    ) {
      throw new Error(
        `Container ${name} does not match the shared test configuration`,
      );
    }
    if (inspected.State.Status !== 'running') {
      await this.command(['start', inspected.Id]);
    }
    const container = await this.#handle(inspected.Id, options.internalPort);
    try {
      await options.healthy?.(container);
      return container;
    } catch (error) {
      await container.disconnect();
      throw error;
    }
  }

  #fingerprint(options: ContainerOptions): string {
    const { resources } = this.defaults;
    return createHash('sha256')
      .update(
        JSON.stringify({
          transportVersion: 2,
          memory: options.memory ?? resources.memory,
          cpus: options.cpus ?? resources.cpus,
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
    const { resources } = this.defaults;
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
    return [
      ...args,
      '--memory',
      options.memory ?? resources.memory,
      '--cpus',
      String(options.cpus ?? resources.cpus),
      '-p',
      `127.0.0.1::${options.internalPort}`,
      options.image,
    ];
  }

  async #inspect(name: string): Promise<InspectedContainer | undefined> {
    try {
      const { stdout } = await this.command(['container', 'inspect', name]);
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
    const { stdout } = await this.command(['port', id, String(internalPort)]);
    const match = stdout.trim().match(/:(\d+)$/);
    if (!match)
      throw new Error(
        `Failed to get mapped port for container ${id}: ${stdout}`,
      );
    const host = await this.#connection();
    const connection = await host.forward(Number.parseInt(match[1], 10));
    return new Container(id, connection.port, this.command, connection.close);
  }
}
