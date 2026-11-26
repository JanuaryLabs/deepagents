import type {
  AccountProvider,
  PostgresAccountStore,
} from './postgres-account-store.ts';

export type RefreshResult<T> =
  { status: 'refreshed'; tokens: T } | { status: 'revoked' };

/**
 * Resolves usable tokens per owner. Refresh tokens rotate on use, so a
 * refresh holds the owner's lock on every host from its read to its write,
 * and it runs on the lock's signal instead of the caller's: dropping a
 * rotated response would strand the account.
 */
export function createTokenResolver<
  T extends { accessToken: string },
>(options: {
  store: PostgresAccountStore;
  provider: AccountProvider;
  parse(value: unknown): T | undefined;
  isFresh(tokens: T): boolean;
  refresh(tokens: T, signal: AbortSignal): Promise<RefreshResult<T>>;
  notConnected(): Error;
  revoked(): Error;
  conflicted(): Error;
  onRevoked(owner: string): void;
}) {
  const { store, provider } = options;
  const read = async (owner: string) =>
    options.parse((await store.account(provider, owner)).tokens);

  async function resolve(
    owner: string,
    rejected: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const usable = (tokens: T) =>
      tokens.accessToken !== rejected && options.isFresh(tokens);
    signal?.throwIfAborted();
    const current = await read(owner);
    if (!current) throw options.notConnected();
    if (usable(current)) return current;
    return store.exclusive(
      provider,
      owner,
      async (lease) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          signal?.throwIfAborted();
          const tokens = await read(owner);
          if (!tokens) throw options.notConnected();
          if (usable(tokens)) return tokens;
          const result = await options.refresh(tokens, lease.signal);
          if (result.status === 'revoked') {
            if (!(await lease.write(null))) continue;
            options.onRevoked(owner);
            throw options.revoked();
          }
          if (await lease.write(result.tokens)) return result.tokens;
        }
        throw options.conflicted();
      },
      signal,
    );
  }

  return {
    fresh: (owner: string, signal?: AbortSignal) =>
      resolve(owner, undefined, signal),
    /** Replaces an access token the server rejected, refreshing at most once. */
    replace: (owner: string, rejected: string, signal?: AbortSignal) =>
      resolve(owner, rejected, signal),
  };
}

/** Sends once, then once more with a replacement credential after a 401. */
export async function retryUnauthorized<C>(
  credential: C,
  send: (credential: C) => Promise<Response>,
  replace: (rejected: C) => Promise<C>,
  rejectedAgain: () => Error,
): Promise<Response> {
  const response = await send(credential);
  if (response.status !== 401) return response;
  await response.body?.cancel();
  const retry = await send(await replace(credential));
  if (retry.status !== 401) return retry;
  await retry.body?.cancel();
  throw rejectedAgain();
}
