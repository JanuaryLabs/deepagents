import type {
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash';

type BufferEncoding = 'utf8' | 'utf-8' | 'ascii' | 'base64' | 'hex' | 'binary';

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

export interface ScopedFsOptions {
  base: IFileSystem;
  prefix: string;
}

/**
 * Filesystem wrapper that prefixes all paths with a given prefix.
 * Enables chat-level isolation without modifying command logic.
 *
 * @example
 * const scopedFs = new ScopedFs({
 *   base: fs,
 *   prefix: '/chat-123',
 * });
 */
export class ScopedFs implements IFileSystem {
  #base: IFileSystem;
  #prefix: string;

  constructor(options: ScopedFsOptions) {
    this.#base = options.base;
    this.#prefix = options.prefix.replace(/\/$/, '');
  }

  #scope(path: string): string {
    return `${this.#prefix}${path}`;
  }

  #unscope(path: string): string {
    if (path === this.#prefix) {
      return '/';
    }
    if (path.startsWith(this.#prefix + '/')) {
      return path.slice(this.#prefix.length) || '/';
    }
    return path;
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.#base.writeFile(this.#scope(path), content, options);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.#base.appendFile(this.#scope(path), content, options);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.#base.mkdir(this.#scope(path), options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.#base.rm(this.#scope(path), options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.#base.cp(this.#scope(src), this.#scope(dest), options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.#base.mv(this.#scope(src), this.#scope(dest));
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.#base.chmod(this.#scope(path), mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.#base.symlink(target, this.#scope(linkPath));
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.#base.link(this.#scope(existingPath), this.#scope(newPath));
  }

  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    return this.#base.readFile(this.#scope(path), options);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.#base.readFileBuffer(this.#scope(path));
  }

  stat(path: string): Promise<FsStat> {
    return this.#base.stat(this.#scope(path));
  }

  lstat(path: string): Promise<FsStat> {
    return this.#base.lstat(this.#scope(path));
  }

  readdir(path: string): Promise<string[]> {
    return this.#base.readdir(this.#scope(path));
  }

  readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.#base.readdirWithFileTypes!(this.#scope(path));
  }

  exists(path: string): Promise<boolean> {
    return this.#base.exists(this.#scope(path));
  }

  readlink(path: string): Promise<string> {
    return this.#base.readlink(this.#scope(path));
  }

  realpath(path: string): Promise<string> {
    return this.#base.realpath(this.#scope(path)).then((p) => this.#unscope(p));
  }

  utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.#base.utimes(this.#scope(path), atime, mtime);
  }

  resolvePath(base: string, relativePath: string): string {
    return this.#base.resolvePath(base, relativePath);
  }

  getAllPaths(): string[] {
    const allPaths = this.#base.getAllPaths?.() ?? [];
    return allPaths
      .filter((p) => p.startsWith(this.#prefix))
      .map((p) => p.slice(this.#prefix.length) || '/');
  }
}
