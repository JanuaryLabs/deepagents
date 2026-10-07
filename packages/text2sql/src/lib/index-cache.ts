import {
  type ContextFragment,
  isFragment,
  isFragmentData,
} from '@deepagents/context';

import { JsonCache } from './file-cache.ts';

/**
 * Stores introspected schema fragments per adapter so repeated indexing can
 * reuse them instead of re-introspecting the database.
 *
 * The package defines this contract but does not own the storage. Hosts decide
 * where the cache lives — a shared volume, Redis, S3, a database — by supplying
 * an implementation. When no cache is provided, indexing always introspects.
 *
 * `key` is a stable per-adapter identifier; the same key is reused for the same
 * adapter across processes, so a cache shared across a fleet lets one process's
 * write satisfy another's read. Indexing does not make concurrent callers wait
 * for each other: to introspect once, the host acquires a key around `index()`.
 */
export interface IndexCache {
  read(key: string): Promise<ContextFragment[] | null>;
  write(key: string, fragments: ContextFragment[]): Promise<void>;
}

export interface FileIndexCacheOptions {
  /** Directory the cache files live in. Defaults to the OS temp directory. */
  dir?: string;
  /**
   * Optional invalidation token folded into the cache key. Change it (e.g. a
   * deploy id or schema version) to start a fresh cache generation.
   */
  namespace?: string;
}

/**
 * File-backed {@link IndexCache} using atomic writes (temp + rename) and
 * treating a file that does not parse to context fragments as a miss. Point
 * {@link FileIndexCacheOptions.dir} at a shared volume to let
 * horizontally-scaled processes share one cache.
 */
export class FileIndexCache implements IndexCache {
  readonly #dir: string | undefined;
  readonly #namespace: string | undefined;

  constructor(options: FileIndexCacheOptions = {}) {
    this.#dir = options.dir;
    this.#namespace = options.namespace;
  }

  read(key: string): Promise<ContextFragment[] | null> {
    return this.#cacheFor(key).read();
  }

  write(key: string, fragments: ContextFragment[]): Promise<void> {
    return this.#cacheFor(key).write(fragments);
  }

  #cacheFor(key: string): JsonCache<ContextFragment[]> {
    const watermark = this.#namespace ? `${this.#namespace}-${key}` : key;
    return new JsonCache(watermark, isFragmentList, this.#dir);
  }
}

function isFragmentList(value: unknown): value is ContextFragment[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isFragment(item) && isFragmentData(item))
  );
}
