import { Mutex } from '@zukhruf/mutex';
import { PostgresStore } from '@zukhruf/mutex/postgres';
import type { Pool } from 'pg';
import { z } from 'zod';

import { PostgresStoreDatabase, lockSchemaDDL } from '@deepagents/context';

export type AccountProvider = 'claude' | 'codex';

export interface PostgresAccountStoreOptions {
  /** Borrowed: the host owns the pool and the store never ends it. */
  pool: Pool;
  /** PostgreSQL schema the account tables live in. Default: `public`. */
  schema?: string;
}

/** A sign-in that waits for its user, readable from every process. */
export interface StoredSignIn {
  /** Identifies this attempt among the owner's sign-ins. */
  state: string;
  /** What the provider needs to finish or show the sign-in. */
  pending: unknown;
  /** The account's fence when the sign-in started; it saves only while unchanged. */
  fence: bigint;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** The owner's account while this process holds its lock. */
export interface AccountLease {
  /** Aborts when the lock is lost; a write after that is refused. */
  signal: AbortSignal;
  /** Replaces the tokens, `null` to disconnect, unless a newer writer wrote. */
  write(tokens: unknown): Promise<boolean>;
  /** Replaces the tokens only while the account's fence is still `observed`. */
  writeIfUnchanged(tokens: unknown, observed: bigint): Promise<boolean>;
  /**
   * Ends the sign-in `state` and saves its tokens in one step, unless the
   * sign-in was cancelled, expired, or the account changed since it started.
   */
  finishSignIn(state: string, tokens: unknown, now: number): Promise<boolean>;
}

const fenceColumn = z
  .string()
  .regex(/^\d+$/)
  .transform((text) => BigInt(text));

const accountRow = z.object({ tokens: z.unknown(), fence: fenceColumn });
const signInRow = z.object({
  state: z.string(),
  pending: z.unknown(),
  fence: fenceColumn,
  expires_at: z
    .string()
    .regex(/^\d+$/)
    .transform((text) => Number(text)),
});
const stateRow = z.object({ state: z.string() });

function accountDDL(schema: string) {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";

CREATE SEQUENCE IF NOT EXISTS "${schema}"."provider_account_fences" AS BIGINT CACHE 1;

CREATE TABLE IF NOT EXISTS "${schema}"."provider_accounts" (
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  tokens JSONB,
  fence BIGINT NOT NULL,
  PRIMARY KEY (provider, owner)
);

CREATE TABLE IF NOT EXISTS "${schema}"."provider_account_sign_ins" (
  provider TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  pending JSONB NOT NULL,
  fence BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (provider, owner)
);
`;
}

/**
 * The accounts of `createClaudeAccounts` and `createCodexAccounts` in
 * Postgres, shared by every process on every host that reaches the database.
 * A refresh holds the owner's advisory lock from the read to the write, and
 * every write carries a fencing token that the row checks, so a holder that
 * lost its lock or a refresh that outlived a disconnect cannot overwrite a
 * newer write.
 */
export class PostgresAccountStore {
  readonly #database: PostgresStoreDatabase;
  readonly #locks: Mutex;
  readonly #sequence: string;

  private constructor(database: PostgresStoreDatabase, pool: Pool) {
    this.#database = database;
    this.#sequence = database.table('provider_account_fences');
    this.#locks = new Mutex(
      new PostgresStore({
        connect: () => pool.connect(),
        sequence: this.#sequence,
        // The mutex documentation's interval: a holder whose session ended
        // learns it within 5 s; the fence refuses its writes until then.
        heartbeatInterval: 5_000,
        clock: globalThis,
      }),
    );
  }

  /** Opens the store: creates its schema objects before it returns. */
  static async create(
    options: PostgresAccountStoreOptions,
  ): Promise<PostgresAccountStore> {
    const database = new PostgresStoreDatabase(options.pool, options.schema);
    await database.query(
      lockSchemaDDL(accountDDL(database.schema), database.schema),
    );
    return new PostgresAccountStore(database, options.pool);
  }

  get #accounts() {
    return this.#database.table('provider_accounts');
  }

  get #signIns() {
    return this.#database.table('provider_account_sign_ins');
  }

  /** The stored tokens (`null` when disconnected) and the fence of their last write. */
  async account(provider: AccountProvider, owner: string) {
    const [row] = await this.#database.rows(
      accountRow,
      `SELECT tokens, fence::text AS fence FROM ${this.#accounts}
       WHERE provider = $1 AND owner = $2`,
      [provider, owner],
    );
    return row ?? { tokens: null, fence: 0n };
  }

  /** Runs `task` while this process holds the owner's lock on every host. */
  exclusive<T>(
    provider: AccountProvider,
    owner: string,
    task: (lease: AccountLease) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const key = JSON.stringify([this.#database.schema, provider, owner]);
    return this.#locks.acquire(
      key,
      ({ signal: leaseSignal, token }) => {
        const fence = token.toString();
        const upsert = (
          tokens: unknown,
          condition: string,
          values: unknown[],
        ) =>
          this.#database.query(
            `INSERT INTO ${this.#accounts} AS account (provider, owner, tokens, fence)
             VALUES ($1, $2, $3::jsonb, $4::bigint)
             ON CONFLICT (provider, owner) DO UPDATE
               SET tokens = EXCLUDED.tokens, fence = EXCLUDED.fence
               WHERE account.fence <= EXCLUDED.fence ${condition}`,
            [provider, owner, json(tokens), fence, ...values],
          );
        return task({
          signal: leaseSignal,
          write: async (tokens) =>
            (await upsert(tokens, '', [])).rowCount === 1,
          writeIfUnchanged: async (tokens, observed) =>
            (
              await upsert(tokens, 'AND account.fence = $5::bigint', [
                observed.toString(),
              ])
            ).rowCount === 1,
          finishSignIn: async (state, tokens, now) => {
            const result = await this.#database.query(
              `WITH taken AS (
                 DELETE FROM ${this.#signIns}
                 WHERE provider = $1 AND owner = $2 AND state = $5 AND expires_at > $6::bigint
                 RETURNING fence
               )
               INSERT INTO ${this.#accounts} AS account (provider, owner, tokens, fence)
               SELECT $1, $2, $3::jsonb, $4::bigint FROM taken
               ON CONFLICT (provider, owner) DO UPDATE
                 SET tokens = EXCLUDED.tokens, fence = EXCLUDED.fence
                 WHERE account.fence <= EXCLUDED.fence
                   AND account.fence = (SELECT fence FROM taken)`,
              [provider, owner, json(tokens), fence, state, now],
            );
            return result.rowCount === 1;
          },
        });
      },
      { signal },
    );
  }

  /**
   * Clears the tokens and ends any sign-in without waiting for the owner's
   * lock. Its fence comes from the lock's own sequence, so it is newer than
   * every lock already granted: a refresh in flight cannot save over it.
   * Resolves with the state of the sign-in it ended.
   */
  async disconnect(
    provider: AccountProvider,
    owner: string,
  ): Promise<string | undefined> {
    const [row] = await this.#database.rows(
      stateRow,
      `WITH cleared AS (
         UPDATE ${this.#accounts}
         SET tokens = NULL, fence = nextval('${this.#sequence}'::regclass)
         WHERE provider = $1 AND owner = $2
       )
       DELETE FROM ${this.#signIns}
       WHERE provider = $1 AND owner = $2
       RETURNING state`,
      [provider, owner],
    );
    return row?.state;
  }

  async signIn(
    provider: AccountProvider,
    owner: string,
  ): Promise<StoredSignIn | undefined> {
    const [row] = await this.#database.rows(
      signInRow,
      `SELECT state, pending, fence::text AS fence, expires_at::text AS expires_at
       FROM ${this.#signIns} WHERE provider = $1 AND owner = $2`,
      [provider, owner],
    );
    return (
      row && {
        state: row.state,
        pending: row.pending,
        fence: row.fence,
        expiresAt: row.expires_at,
      }
    );
  }

  /** Starts a sign-in, replacing the owner's previous one. */
  async beginSignIn(
    provider: AccountProvider,
    owner: string,
    signIn: StoredSignIn,
  ): Promise<void> {
    await this.#database.query(
      `INSERT INTO ${this.#signIns} (provider, owner, state, pending, fence, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::bigint, $6::bigint)
       ON CONFLICT (provider, owner) DO UPDATE
         SET state = EXCLUDED.state, pending = EXCLUDED.pending,
             fence = EXCLUDED.fence, expires_at = EXCLUDED.expires_at`,
      [
        provider,
        owner,
        signIn.state,
        json(signIn.pending),
        signIn.fence.toString(),
        signIn.expiresAt,
      ],
    );
  }

  /** Replaces what sign-in `state` shows, while it is still the owner's sign-in. */
  async updateSignIn(
    provider: AccountProvider,
    owner: string,
    state: string,
    pending: unknown,
  ): Promise<boolean> {
    const result = await this.#database.query(
      `UPDATE ${this.#signIns} SET pending = $4::jsonb
       WHERE provider = $1 AND owner = $2 AND state = $3`,
      [provider, owner, state, json(pending)],
    );
    return result.rowCount === 1;
  }

  /**
   * Ends the owner's sign-in, or only sign-in `state` when given, once:
   * resolves with the state of the sign-in it ended.
   */
  async takeSignIn(
    provider: AccountProvider,
    owner: string,
    state?: string,
  ): Promise<string | undefined> {
    const [row] = await this.#database.rows(
      stateRow,
      `DELETE FROM ${this.#signIns}
       WHERE provider = $1 AND owner = $2 AND ($3::text IS NULL OR state = $3)
       RETURNING state`,
      [provider, owner, state ?? null],
    );
    return row?.state;
  }
}

function json(value: unknown) {
  return value === null ? null : JSON.stringify(value);
}
