import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class FileCache {
  public path: string;
  constructor(watermark: string, extension = '.txt') {
    const hash = createHash('md5').update(watermark).digest('hex');
    this.path = path.join(tmpdir(), `text2sql-${hash}${extension}`);
  }

  async get() {
    if (existsSync(this.path)) {
      return readFile(this.path, 'utf-8');
    }
    return null;
  }

  set(content: string) {
    return writeFile(this.path, content, 'utf-8');
  }
}

export class JsonCache<T> extends FileCache {
  constructor(watermark: string) {
    super(watermark, '.json');
  }

  async read(): Promise<T | null> {
    const content = await this.get();
    if (content) {
      return JSON.parse(content) as T;
    }
    return null;
  }

  write(data: T) {
    return this.set(JSON.stringify(data));
  }
}
