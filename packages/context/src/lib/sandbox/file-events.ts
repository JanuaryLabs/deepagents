import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export type FileEventOp = 'read' | 'write' | 'delete' | 'modify';

export interface FileEvent {
  path: string;
  op: FileEventOp;
  timestamp: number;
}

export class ObservedFs implements IFileSystem {
  readonly #base: IFileSystem;
  #events: FileEvent[] = [];
  readdirWithFileTypes?: (path: string) => Promise<DirentEntry[]>;

  constructor(base: IFileSystem) {
    this.#base = base;
    if (base.readdirWithFileTypes) {
      this.readdirWithFileTypes = (path) => base.readdirWithFileTypes!(path);
    }
  }

  drain(): FileEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  #record(op: FileEventOp, path: string): void {
    this.#events.push({ path, op, timestamp: Date.now() });
  }

  async readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const content = await this.#base.readFile(path, options);
    this.#record('read', path);
    return content;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const content = await this.#base.readFileBuffer(path);
    this.#record('read', path);
    return content;
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const existed = await this.#base.exists(path);
    await this.#base.writeFile(path, content, options);
    this.#record(existed ? 'modify' : 'write', path);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const existed = await this.#base.exists(path);
    await this.#base.appendFile(path, content, options);
    this.#record(existed ? 'modify' : 'write', path);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const toRecord = options?.recursive
      ? await this.#walk(path, { includeRoot: true })
      : (await this.#base.exists(path))
        ? [path]
        : [];
    await this.#base.rm(path, options);
    for (const p of toRecord) {
      this.#record('delete', p);
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    if (options?.recursive) {
      const sources = await this.#walk(src, { includeRoot: false });
      const destChecks = await Promise.all(
        sources.map(async (srcFile) => {
          const relative = srcFile.slice(src.length);
          const destFile = this.#joinPath(dest, relative);
          return {
            srcFile,
            destFile,
            existed: await this.#base.exists(destFile),
          };
        }),
      );
      await this.#base.cp(src, dest, options);
      for (const { srcFile, destFile, existed } of destChecks) {
        this.#record('read', srcFile);
        this.#record(existed ? 'modify' : 'write', destFile);
      }
      return;
    }
    const destExisted = await this.#base.exists(dest);
    await this.#base.cp(src, dest, options);
    this.#record('read', src);
    this.#record(destExisted ? 'modify' : 'write', dest);
  }

  async #walk(
    root: string,
    { includeRoot }: { includeRoot: boolean },
  ): Promise<string[]> {
    if (!(await this.#base.exists(root))) return [];
    const stat = await this.#base.stat(root);
    if (!stat.isDirectory) return [root];

    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await this.#base.readdir(dir);
      for (const name of entries) {
        const child = this.#joinPath(dir, name);
        const childStat = await this.#base.stat(child);
        if (childStat.isDirectory) {
          await visit(child);
        } else {
          out.push(child);
        }
      }
    };
    await visit(root);
    if (includeRoot) out.push(root);
    return out;
  }

  #joinPath(a: string, b: string): string {
    if (!b) return a;
    if (b.startsWith('/')) return `${a.replace(/\/$/, '')}${b}`;
    return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`;
  }

  async mv(src: string, dest: string): Promise<void> {
    const destExisted = await this.#base.exists(dest);
    await this.#base.mv(src, dest);
    this.#record('delete', src);
    this.#record(destExisted ? 'modify' : 'write', dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.#base.symlink(target, linkPath);
    this.#record('write', linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.#base.link(existingPath, newPath);
    this.#record('write', newPath);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.#base.mkdir(path, options);
  }

  exists(path: string): Promise<boolean> {
    return this.#base.exists(path);
  }

  stat(path: string): Promise<FsStat> {
    return this.#base.stat(path);
  }

  lstat(path: string): Promise<FsStat> {
    return this.#base.lstat(path);
  }

  readdir(path: string): Promise<string[]> {
    return this.#base.readdir(path);
  }

  readlink(path: string): Promise<string> {
    return this.#base.readlink(path);
  }

  realpath(path: string): Promise<string> {
    return this.#base.realpath(path);
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#base.chmod(path, mode);
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.#base.utimes(path, atime, mtime);
  }

  resolvePath(base: string, path: string): string {
    return this.#base.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.#base.getAllPaths();
  }
}
