import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { type LockOptions, lock as acquireLock } from 'proper-lockfile';

/**
 * Coordinates schema indexing across processes so that, for a given cache key,
 * only one introspection runs at a time ("single-flight" indexing).
 *
 * The package defines this contract but ships no implementation and takes no
 * dependency on a lock store. Hosts that run many processes against the same
 * database (e.g. horizontally-scaled daemons) supply an implementation backed
 * by whatever they already operate — a Redis lock, a Postgres advisory lock, a
 * Zookeeper/etcd lease, or an in-process mutex for a single-process deployment.
 *
 * When no lock is provided, indexing behaves exactly as if this interface did
 * not exist.
 */
export interface IndexLock {
  /**
   * Run `fn` under an exclusive lock identified by `key`.
   *
   * Implementations MUST acquire the lock (waiting if it is currently held
   * elsewhere), run `fn`, then release it — even if `fn` throws. Failure to
   * acquire the lock MUST reject: callers treat a lock-store failure as fatal
   * (fail-closed) rather than racing an unprotected introspection.
   *
   * @param key   - Stable identifier for the work being guarded; the same key
   *                is used for the same adapter + index version, so distinct
   *                adapters lock independently.
   * @param fn    - The critical section to run while the lock is held.
   * @returns The value returned by `fn`.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES: LockOptions['retries'] = {
  retries: 10,
  factor: 2,
  minTimeout: 100,
  maxTimeout: 2_000,
};

export interface FileIndexLockOptions extends Pick<
  LockOptions,
  'stale' | 'retries'
> {
  /**
   * Directory the lock files live in. Defaults to the OS temp directory. Point
   * it at a shared volume to serialize introspection across a fleet, alongside a
   * {@link import('./index-cache.ts').FileIndexCache} over the same volume.
   */
  dir?: string;
  /**
   * Token folded into the lock key, mirroring
   * {@link import('./index-cache.ts').FileIndexCacheOptions.namespace} so a new
   * generation locks independently of the previous one.
   */
  namespace?: string;
}

/**
 * Filesystem-backed {@link IndexLock} built on `proper-lockfile`. Processes that
 * share a POSIX filesystem (a single host, or a shared volume — NFSv4 / EFS)
 * serialize per adapter key, so pairing it with a shared
 * {@link import('./index-cache.ts').FileIndexCache} makes cross-process
 * introspection single-flight.
 *
 * A held lock auto-refreshes its mtime at `stale / 2`, so a slow introspection
 * is not mistaken for a crashed holder. Acquisition retries with backoff and,
 * once exhausted, rejects — satisfying the fail-closed requirement of
 * {@link IndexLock}.
 */
export class FileIndexLock implements IndexLock {
  readonly #dir: string;
  readonly #namespace: string | undefined;
  readonly #stale: LockOptions['stale'];
  readonly #retries: LockOptions['retries'];

  constructor(options: FileIndexLockOptions = {}) {
    this.#dir = options.dir ?? tmpdir();
    this.#namespace = options.namespace;
    this.#stale = options.stale ?? DEFAULT_STALE_MS;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.#dir, { recursive: true });
    const release = await acquireLock(this.#lockPathFor(key), {
      realpath: false,
      stale: this.#stale,
      retries: this.#retries,
    });
    try {
      return await fn();
    } finally {
      // Best-effort release: fn() has already settled (and the caller has
      // its result), so a compromised or already-released lock must not
      // surface as a failure that masks that result.
      await release().catch(() => {});
    }
  }

  #lockPathFor(key: string): string {
    const watermark = this.#namespace ? `${this.#namespace}-${key}` : key;
    const hash = createHash('md5').update(watermark).digest('hex');
    return path.join(this.#dir, `text2sql-lock-${hash}`);
  }
}
