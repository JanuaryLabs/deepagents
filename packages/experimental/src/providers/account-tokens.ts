import type { KeyValueStore } from '@opencoredev/loginwithchatgpt-core';
import { MemoryStore, Mutex } from '@zukhruf/mutex';

export interface TokenSnapshot<T> {
  tokens: T | undefined;
  revision: number;
}

export type RefreshResult<T> =
  { status: 'refreshed'; tokens: T } | { status: 'revoked' };

/**
 * Compare-and-swap over an app-owned store, so a stale refresh or sign-in
 * cannot overwrite a disconnect or a newly connected account. Revisions live
 * in this process: one instance must own each store.
 */
export function createTokenVault<T>(
  store: KeyValueStore<T>,
  parse: (value: unknown) => T | undefined,
) {
  const revisions = new Map<string, number>();
  const serialized = new Mutex(new MemoryStore());
  const revision = (owner: string) => revisions.get(owner) ?? 0;

  return {
    snapshot: (owner: string) =>
      serialized.acquire(owner, async (): Promise<TokenSnapshot<T>> => ({
        tokens: parse(await store.get(owner)),
        revision: revision(owner),
      })),
    commit: (owner: string, tokens: T, expectedRevision: number) =>
      serialized.acquire(owner, async () => {
        if (revision(owner) !== expectedRevision) return false;
        await store.set(owner, tokens);
        revisions.set(owner, revision(owner) + 1);
        return true;
      }),
    clear: (owner: string, expectedRevision?: number) =>
      serialized.acquire(owner, async () => {
        if (
          expectedRevision !== undefined &&
          revision(owner) !== expectedRevision
        ) {
          return false;
        }
        await store.delete(owner);
        revisions.set(owner, revision(owner) + 1);
        return true;
      }),
  };
}

export type TokenVault<T> = ReturnType<typeof createTokenVault<T>>;

/**
 * Resolves usable tokens per owner. Refresh tokens rotate on use, so every
 * resolution for one owner runs exclusively and refreshes ignore the caller's
 * abort signal: dropping a rotated response would strand the account.
 */
export function createTokenResolver<
  T extends { accessToken: string },
>(options: {
  vault: TokenVault<T>;
  isFresh(tokens: T): boolean;
  refresh(tokens: T): Promise<RefreshResult<T>>;
  notConnected(): Error;
  revoked(): Error;
  conflicted(): Error;
  onRevoked(owner: string): void;
}) {
  const exclusive = new Mutex(new MemoryStore());

  async function resolve(
    owner: string,
    rejected: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const { tokens, revision } = await options.vault.snapshot(owner);
      if (!tokens) throw options.notConnected();
      if (tokens.accessToken !== rejected && options.isFresh(tokens)) {
        return tokens;
      }
      const result = await options.refresh(tokens);
      if (result.status === 'revoked') {
        if (!(await options.vault.clear(owner, revision))) continue;
        options.onRevoked(owner);
        throw options.revoked();
      }
      if (await options.vault.commit(owner, result.tokens, revision)) {
        return result.tokens;
      }
    }
    throw options.conflicted();
  }

  return {
    fresh: (owner: string, signal?: AbortSignal) =>
      exclusive.acquire(owner, () => resolve(owner, undefined, signal), {
        signal,
      }),
    /** Replaces an access token the server rejected, refreshing at most once. */
    replace: (owner: string, rejected: string, signal?: AbortSignal) =>
      exclusive.acquire(owner, () => resolve(owner, rejected, signal), {
        signal,
      }),
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
