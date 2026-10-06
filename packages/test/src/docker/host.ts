import command from 'nano-spawn';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempDisposable, rm, stat, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';

import { timebox } from '../async/timebox.ts';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Resolve with the Docker CLI so its native context/environment precedence wins. */
export class DockerHost {
  readonly endpoint: string;

  private constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

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
    const resources = new AsyncDisposableStack();
    const record = process.env.DEEPAGENTS_TEST_RUN_DIR
      ? join(
          process.env.DEEPAGENTS_TEST_RUN_DIR,
          `forward-${randomUUID()}.json`,
        )
      : undefined;
    const close = async () => {
      await resources.disposeAsync();
      if (record) await rm(record, { force: true });
    };
    try {
      // Keep the Unix socket path below macOS's 104-byte limit. The private
      // directory and ownership record also cover workers killed mid-test.
      const directory = resources.use(
        await mkdtempDisposable(
          `/tmp/deepagents-forward-${process.env.DEEPAGENTS_TEST_RUN_ID ?? 'standalone'}-`,
        ),
      );
      if (record)
        await writeFile(record, JSON.stringify({ path: directory.path }));
      const path = join(directory.path, 's');
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        const channel = connect(path);
        for (const [stream, peer] of [
          [socket, channel],
          [channel, socket],
        ]) {
          sockets.add(stream);
          stream.on('error', () => peer.destroy());
          stream.once('close', () => {
            sockets.delete(stream);
            peer.destroy();
          });
        }
        socket.pipe(channel).pipe(socket);
      });
      // OpenSSH multiplexes client streams over one authenticated connection.
      // Node owns the ephemeral TCP listener, so no port-reservation race or
      // fresh SSH login is added to each database client's connect timeout.
      const child = spawn(
        'ssh',
        this.sshArgs([
          '-N',
          '-S',
          'none',
          '-o',
          'ControlMaster=no',
          '-o',
          'ControlPersist=no',
          '-o',
          'ExitOnForwardFailure=yes',
          '-L',
          `${path}:127.0.0.1:${port}`,
        ]),
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errorOutput = '';
      let spawnError: Error | undefined;
      child.stderr.on('data', (data) => {
        errorOutput += data;
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      const exited = new Promise<void>((resolve) =>
        child.once('close', (code) => {
          if (code && errorOutput)
            process.stderr.write(`Docker SSH forwarding: ${errorOutput}`);
          for (const socket of sockets) socket.destroy();
          if (server.listening) server.close();
          resolve();
        }),
      );
      resources.defer(async () => {
        child.kill('SIGTERM');
        const deadline = setTimeout(() => child.kill('SIGKILL'), 1_000);
        try {
          await exited;
        } finally {
          clearTimeout(deadline);
        }
      });
      resources.defer(async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) =>
            error &&
            !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')
              ? reject(error)
              : resolve(),
          ),
        );
        for (const socket of sockets) socket.destroy();
        await closed;
      });
      // OpenSSH binds local forwards after authentication. Wait for that
      // listener before publishing the TCP port to a database client.
      await timebox(
        async () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `Docker SSH forwarding exited: ${errorOutput.trim()}`,
            );
          if (!(await stat(path)).isSocket())
            throw new Error(
              'Docker SSH forwarding did not create a Unix socket',
            );
        },
        {
          maxRetryTime: 15_000,
          shouldRetry: ({ error }) =>
            !spawnError && 'code' in error && error.code === 'ENOENT',
        },
      );
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Docker forwarding did not acquire a TCP port');
      return { port: address.port, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
