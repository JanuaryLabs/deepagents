import { Lock } from '@zukhruf/async';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';

/** A storage part was called inside an admission: the admission's work must use its scope. */
export class AdmissionScopeError extends Error {
  override readonly name = 'AdmissionScopeError';

  constructor() {
    super(
      "EmbeddedAgentStorage: an admission's work called the storage itself; inside admit, read and write through the AdmissionScope it was given",
    );
  }
}

/** The admission an async context runs in; `open` until its transaction ends. */
interface RunningAdmission {
  open: boolean;
}

/**
 * Shares one SQLite connection between the storage's parts and its
 * admissions. A transaction on a connection holds every statement the
 * connection runs, so while an admission's `BEGIN IMMEDIATE` is open no other
 * call may reach the connection: its writes would commit or roll back with
 * the admission, and its reads would see rows the admission may still roll
 * back. Each call through `view` and each admission therefore holds the
 * connection alone, in the order they came. A call's body runs synchronously
 * on node:sqlite, so taking turns costs no concurrency SQLite would allow.
 *
 * Admissions run one at a time, for every tree: SQLite has one writer per database.
 */
export class SqliteAdmissionGate {
  readonly #database: DatabaseSync;
  readonly #connection = new Lock();
  readonly #admission = new AsyncLocalStorage<RunningAdmission>();

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  /** `part` with every method run through `call`. */
  view<Part extends object>(part: Part): Part {
    return new Proxy(part, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): Promise<unknown> =>
          this.call(async () => Reflect.apply(value, target, args));
      },
    });
  }

  /** Runs `operation` while it holds the connection alone. */
  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#insideAdmission()) throw new AdmissionScopeError();
    return this.#connection.run(operation, { signal: undefined });
  }

  /** Runs `work` in one `BEGIN IMMEDIATE` transaction: commits when it resolves, rolls back when it throws. */
  async admit<T>(work: () => Promise<T>): Promise<T> {
    if (this.#insideAdmission()) throw new AdmissionScopeError();
    return this.#connection.run(
      async () => {
        const admission: RunningAdmission = { open: true };
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          const result = await this.#admission.run(admission, work);
          this.#database.exec('COMMIT');
          return result;
        } catch (error) {
          // SQLite ends the transaction itself after some errors; a ROLLBACK then would hide the original error.
          if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
          throw error;
        } finally {
          admission.open = false;
        }
      },
      { signal: undefined },
    );
  }

  /**
   * Inside its own admission a call would wait for that admission to end,
   * which waits for the call. Work the admission left running after it
   * ended is no longer inside it.
   */
  #insideAdmission(): boolean {
    return this.#admission.getStore()?.open === true;
  }
}
