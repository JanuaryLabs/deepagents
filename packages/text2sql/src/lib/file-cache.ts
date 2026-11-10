import type { Clock } from '@zukhruf/async';
import { atomicWrite } from '@zukhruf/fs';
import { hash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FileCacheOptions {
  /** The clock of the waits of a write that retries a busy file. */
  clock: Clock;
  /** Default: `.txt`. */
  extension?: string;
  /** Default: the OS temp directory. */
  baseDir?: string;
}

export class FileCache {
  public path: string;
  readonly #clock: Clock;
  constructor(
    watermark: string,
    { clock, extension = '.txt', baseDir = tmpdir() }: FileCacheOptions,
  ) {
    const digest = hash('md5', watermark);
    this.path = path.join(baseDir, `text2sql-${digest}${extension}`);
    this.#clock = clock;
  }

  async get() {
    if (existsSync(this.path)) {
      return readFile(this.path, 'utf-8');
    }
    return null;
  }

  async set(content: string) {
    await mkdir(path.dirname(this.path), { recursive: true });
    await atomicWrite(this.path, content, { clock: this.#clock });
  }
}

export class JsonCache<T> extends FileCache {
  #isValid: (value: unknown) => value is T;

  /**
   * @param isValid - Checks that a parsed cache file holds a T; a file that
   * fails it is read as a miss.
   */
  constructor(
    watermark: string,
    isValid: (value: unknown) => value is T,
    { clock, baseDir }: Omit<FileCacheOptions, 'extension'>,
  ) {
    super(watermark, { clock, extension: '.json', baseDir });
    this.#isValid = isValid;
  }

  async read(): Promise<T | null> {
    const content = await this.get();
    if (!content) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(content);
      return this.#isValid(value) ? value : null;
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
