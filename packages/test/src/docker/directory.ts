import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { DockerHost, quote } from './host.ts';

/** A disposable fixture directory on the selected daemon's host filesystem. */
export class DockerDirectory implements AsyncDisposable {
  readonly path: string;
  readonly host: DockerHost;
  readonly #record: string | undefined;

  private constructor(
    path: string,
    host: DockerHost,
    record: string | undefined,
  ) {
    this.path = path;
    this.host = host;
    this.#record = record;
  }

  static async create(host: DockerHost): Promise<DockerDirectory> {
    const id = randomUUID();
    const name = `deepagents-test-${process.env.DEEPAGENTS_TEST_RUN_ID ?? 'standalone'}-${id}`;
    const path = host.remote ? `/tmp/${name}` : join(tmpdir(), name);
    const record = process.env.DEEPAGENTS_TEST_RUN_DIR
      ? join(process.env.DEEPAGENTS_TEST_RUN_DIR, `directory-${id}.json`)
      : undefined;
    if (record) await writeFile(record, JSON.stringify({ path }));
    if (host.remote) await host.shell(`mkdir -m 700 -- ${quote(path)}`);
    else await mkdir(path, { mode: 0o700 });
    return new DockerDirectory(path, host, record);
  }

  private resolve(name: string): string {
    if (posix.isAbsolute(name) || name.split('/').includes('..'))
      throw new Error('Fixture paths must stay inside their directory');
    return posix.join(this.path, name);
  }

  async mkdir(name: string): Promise<void> {
    const path = this.resolve(name);
    if (this.host.remote) await this.host.shell(`mkdir -p -- ${quote(path)}`);
    else await mkdir(path, { recursive: true });
  }

  async writeFile(name: string, content: string, mode = 0o644): Promise<void> {
    const path = this.resolve(name);
    if (this.host.remote)
      await this.host.shell(
        `cat > ${quote(path)} && chmod ${mode.toString(8)} -- ${quote(path)}`,
        content,
      );
    else {
      await writeFile(path, content);
      await chmod(path, mode);
    }
  }

  async readFile(name: string): Promise<string> {
    const path = this.resolve(name);
    // base64 prevents nano-spawn from stripping the fixture's trailing newline.
    if (this.host.remote)
      return Buffer.from(
        (await this.host.shell(`base64 < ${quote(path)}`)).stdout,
        'base64',
      ).toString('utf8');
    return readFile(path, 'utf8');
  }

  async chmod(name: string, mode: number): Promise<void> {
    const path = this.resolve(name);
    if (this.host.remote)
      await this.host.shell(`chmod ${mode.toString(8)} -- ${quote(path)}`);
    else await chmod(path, mode);
  }

  async symlink(target: string, name: string): Promise<void> {
    const path = this.resolve(name);
    if (this.host.remote)
      await this.host.shell(`ln -s -- ${quote(target)} ${quote(path)}`);
    else await symlink(target, path);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.host.remote)
      await this.host.shell(`rm -rf -- ${quote(this.path)}`);
    else await rm(this.path, { recursive: true, force: true });
    if (this.#record) await rm(this.#record, { force: true });
  }
}
