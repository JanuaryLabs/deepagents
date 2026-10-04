import command from 'nano-spawn';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Resolve with the Docker CLI so its native context/environment precedence wins. */
export class DockerHost {
  private constructor(readonly endpoint: string) {}

  static async resolve(): Promise<DockerHost> {
    const { stdout } = await command('docker', [
      'context',
      'inspect',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ]);
    const endpoint = stdout.trim();
    if (!endpoint.startsWith('unix://') && !endpoint.startsWith('ssh://')) {
      throw new Error(
        `Unsupported Docker endpoint ${endpoint}; tests support unix:// and ssh://`,
      );
    }
    return new DockerHost(endpoint);
  }

  get remote(): boolean {
    return this.endpoint.startsWith('ssh://');
  }

  readonly command = (args: string[]) =>
    command('docker', args, {
      env: { DOCKER_CONTEXT: undefined, DOCKER_HOST: this.endpoint },
      timeout: 240_000,
    });

  sshArgs(options: string[] = []): string[] {
    const url = new URL(this.endpoint);
    // Pass the original hostname to OpenSSH: ~/.ssh/config, jump hosts, keys,
    // agents and host-key policy continue to work exactly as for Docker.
    return [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=2',
      ...(url.port ? ['-p', url.port] : []),
      ...(url.username ? ['-l', decodeURIComponent(url.username)] : []),
      ...options,
      url.hostname,
    ];
  }

  shell(script: string, input?: string) {
    return command('ssh', [...this.sshArgs(), script], {
      stdin: input === undefined ? 'ignore' : { string: input },
      timeout: 30_000,
    });
  }

  async forward(
    port: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    if (!this.remote) return { port, close: async () => {} };
    const channels = new Set<() => Promise<void>>();
    // Bind port zero ourselves: no find-a-free-port race, no globally running
    // SSH master. Each client stream owns one SSH direct-tcpip channel.
    const server = createServer((socket) => {
      const child = spawn('ssh', this.sshArgs(['-W', `127.0.0.1:${port}`]), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise<void>((resolve) =>
        child.once('close', () => resolve()),
      );
      const stop = async () => {
        socket.destroy();
        child.kill('SIGTERM');
        const kill = setTimeout(() => child.kill('SIGKILL'), 1_000);
        kill.unref();
        await closed;
        clearTimeout(kill);
      };
      channels.add(stop);
      let errorOutput = '';
      child.stderr.on('data', (data) => {
        errorOutput += data;
      });
      child.on('error', () => socket.destroy());
      child.stdin.on('error', () => socket.destroy());
      socket.on('error', () => child.kill('SIGTERM'));
      socket.once('close', () => child.kill('SIGTERM'));
      child.once('close', (code) => {
        if (code && errorOutput)
          process.stderr.write(`Docker SSH forwarding: ${errorOutput}`);
        socket.destroy();
        channels.delete(stop);
      });
      socket.pipe(child.stdin);
      child.stdout.pipe(socket);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Docker forwarding did not acquire a TCP port');
    return {
      port: address.port,
      close: async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
              ? reject(error)
              : resolve(),
          ),
        );
        await Promise.all([...channels].map((stop) => stop()));
        await closed;
      },
    };
  }
}
