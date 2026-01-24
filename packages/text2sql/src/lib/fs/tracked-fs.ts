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

export class TrackedFs implements IFileSystem {
  #base: IFileSystem;
  #createdFiles: Set<string> = new Set();

  constructor(base: IFileSystem) {
    this.#base = base;
  }

  getCreatedFiles(): string[] {
    return [...this.#createdFiles];
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.#base.writeFile(path, content, options);
    this.#createdFiles.add(path);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    await this.#base.appendFile(path, content, options);
    this.#createdFiles.add(path);
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.#base.mkdir(path, options);
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.#base.rm(path, options);
    this.#createdFiles.delete(path);

    if (options?.recursive) {
      const prefix = path.endsWith('/') ? path : path + '/';
      for (const file of this.#createdFiles) {
        if (file.startsWith(prefix)) {
          this.#createdFiles.delete(file);
        }
      }
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.#base.cp(src, dest, options);
    this.#createdFiles.add(dest);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.#base.mv(src, dest);
    this.#createdFiles.delete(src);
    this.#createdFiles.add(dest);
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.#base.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.#base.symlink(target, linkPath);
    this.#createdFiles.add(linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.#base.link(existingPath, newPath);
    this.#createdFiles.add(newPath);
  }

  readFile(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    return this.#base.readFile(path, options);
  }

  readFileBuffer(path: string): Promise<Uint8Array> {
    return this.#base.readFileBuffer(path);
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

  readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.#base.readdirWithFileTypes!(path);
  }

  exists(path: string): Promise<boolean> {
    return this.#base.exists(path);
  }

  readlink(path: string): Promise<string> {
    return this.#base.readlink(path);
  }

  resolvePath(base: string, relativePath: string): string {
    return this.#base.resolvePath(base, relativePath);
  }

  getAllPaths(): string[] {
    return this.#base.getAllPaths?.() ?? [];
  }
}
