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
