import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class FileCache {
  public path: string;
  constructor(
    watermark: string,
    extension = '.txt',
    baseDir: string = tmpdir(),
  ) {
    const hash = createHash('md5').update(watermark).digest('hex');
    this.path = path.join(baseDir, `text2sql-${hash}${extension}`);
  }

  async get() {
    if (existsSync(this.path)) {
      return readFile(this.path, 'utf-8');
    }
    return null;
  }

  async set(content: string) {
    await mkdir(path.dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, this.path);
  }
}

export class JsonCache<T> extends FileCache {
  constructor(watermark: string, baseDir?: string) {
    super(watermark, '.json', baseDir);
  }

  async read(): Promise<T | null> {
    const content = await this.get();
    if (!content) {
      return null;
    }
    try {
      return JSON.parse(content) as T;
    } catch {
      // Corrupt or legacy cache file (e.g. a torn write on a non-atomic
      // shared volume): treat as a miss so the caller re-introspects and
      // atomically rewrites it, rather than throwing.
      return null;
    }
  }

  write(data: T) {
    return this.set(JSON.stringify(data));
  }
}
