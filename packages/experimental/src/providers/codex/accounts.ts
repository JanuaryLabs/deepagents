import {
  type ChatGPTTokens,
  type ChatGPTUser,
  type CodexAuth,
  type DeviceCode,
  type KeyValueStore,
  type ResolvedConfig,
  createCodexFetch,
  deriveAccountId,
  ensureFreshTokens,
  extractCodexModelSlugs,
  isAccessTokenExpired,
  isRefreshTokenInvalid,
  parseUser,
  requestDeviceCode,
  resolveConfig,
  waitForDeviceTokens,
} from '@opencoredev/loginwithchatgpt-core';
import { z } from 'zod';

import {
  type RefreshResult,
  createTokenResolver,
  createTokenVault,
  retryUnauthorized,
} from '../account-tokens.ts';
import { requestSignal } from '../request-signal.ts';
import { CodexAuthError } from './errors.ts';
import { codexProvider } from './provider.ts';

const REQUEST_TIMEOUT_MS = 30_000;

const chatgptTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  idToken: z.string().optional(),
  accountId: z.string().optional(),
  expiresAt: z.number().optional(),
});

export type CodexConnectionState =
  | { status: 'unauthenticated' }
  | {
      status: 'pending';
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
    }
  | { status: 'connected'; user: ChatGPTUser | null }
  | { status: 'error'; message: string };

export interface CodexAccountsOptions {
  /** Holds each owner's tokens, keyed by the owner passed to every method. */
  store: KeyValueStore<ChatGPTTokens>;
  /** Receives every connection change, including device sign-in completion. */
  onChange?: (owner: string, state: CodexConnectionState) => void;
}

interface PendingSignIn {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  revision: number;
  abort: AbortController;
}

/**
 * ChatGPT subscriptions owned by the application rather than the local Codex
 * login: device sign-in, refresh, and models per owner. Create one instance
 * per store; refresh serialization lives in the instance.
 */
export function createCodexAccounts(options: CodexAccountsOptions) {
  const vault = createTokenVault(
    options.store,
    (value) => chatgptTokens.safeParse(value).data,
  );
  const signIns = new Map<string, PendingSignIn>();
  const tokens = createTokenResolver<ChatGPTTokens>({
    vault,
    isFresh: (current) => !isAccessTokenExpired(current),
    refresh: refreshTokens,
    notConnected: () =>
      new CodexAuthError(
        'not-connected',
        'No ChatGPT account is connected. Connect one before using this model.',
      ),
    revoked: () =>
      new CodexAuthError(
        'refresh-token-invalid',
        'The ChatGPT connection expired or was revoked. Connect the account again.',
      ),
    conflicted: () =>
      new CodexAuthError(
        'refresh-failed',
        'The ChatGPT connection changed repeatedly during refresh. Retry the request.',
      ),
    onRevoked: (owner) => void publish(owner),
  });

  function authorizedFetch(owner: string): typeof globalThis.fetch {
    return async (input, init) => {
      const signal = requestSignal(input, init);
      const config = resolveConfig();
      return retryUnauthorized(
        codexAuth(await tokens.fresh(owner, signal)),
        (auth) =>
          createCodexFetch({ config, getAuth: () => auth })(input, init),
        async (rejected) =>
          codexAuth(await tokens.replace(owner, rejected.accessToken, signal)),
        () =>
          new CodexAuthError(
            'access-token-invalid',
            'OpenAI rejected the ChatGPT connection. Connect the account again.',
          ),
      );
    };
  }

  async function state(owner: string): Promise<CodexConnectionState> {
    const signIn = signIns.get(owner);
    if (signIn) return pending(signIn);
    try {
      const { tokens: current } = await vault.snapshot(owner);
      if (!current) return { status: 'unauthenticated' };
      return { status: 'connected', user: parseUser(current.idToken) ?? null };
    } catch (error) {
      return {
        status: 'error',
        message: messageOf(error, 'Reading the ChatGPT connection failed.'),
      };
    }
  }

  function emit(owner: string, current: CodexConnectionState) {
    options.onChange?.(owner, current);
    return current;
  }

  async function publish(owner: string) {
    return emit(owner, await state(owner));
  }

  function cancel(owner: string) {
    const signIn = signIns.get(owner);
    if (!signIn) return;
    signIns.delete(owner);
    signIn.abort.abort();
  }

  async function waitForSignIn(
    owner: string,
    signIn: PendingSignIn,
    config: ResolvedConfig,
    device: DeviceCode,
  ) {
    // Every sign-in ends with a report. One abandoned by cancel or disconnect
    // reports the current state and never saves its tokens: cancel leaves the
    // store revision unchanged, so only this check stops a late save.
    try {
      const fresh = await waitForDeviceTokens(config, device, {
        signal: signIn.abort.signal,
      });
      if (signIns.get(owner) === signIn) {
        await vault.commit(owner, fresh, signIn.revision);
      }
    } catch (error) {
      if (signIns.get(owner) === signIn) {
        signIns.delete(owner);
        emit(owner, {
          status: 'error',
          message: messageOf(error, 'ChatGPT sign-in failed.'),
        });
        return;
      }
    }
    if (signIns.get(owner) === signIn) signIns.delete(owner);
    await publish(owner);
  }

  /**
   * Starts device sign-in and resolves with the pending code; open
   * `verificationUrl` for the user. Completion arrives through `onChange`.
   */
  async function connect(owner: string): Promise<CodexConnectionState> {
    const existing = await state(owner);
    if (existing.status !== 'unauthenticated') return existing;
    const { revision } = await vault.snapshot(owner);

    // The library sends the device code request, the polls and the code
    // exchange without a signal. This fetch gives each the sign-in's, so a
    // cancel also stops the request in flight.
    const abort = new AbortController();
    const config = resolveConfig({
      fetch: (input, init) => {
        const signal = requestSignal(input, init);
        return globalThis.fetch(input, {
          ...init,
          signal: signal
            ? AbortSignal.any([signal, abort.signal])
            : abort.signal,
        });
      },
    });
    let device: DeviceCode;
    try {
      device = await requestDeviceCode(config);
    } catch (error) {
      return emit(owner, {
        status: 'error',
        message: messageOf(error, 'ChatGPT sign-in failed.'),
      });
    }

    cancel(owner);
    const signIn: PendingSignIn = {
      userCode: device.userCode,
      verificationUrl: device.verificationUrl,
      expiresAt: new Date(device.expiresAt).toISOString(),
      revision,
      abort,
    };
    signIns.set(owner, signIn);
    const current = emit(owner, pending(signIn));
    void waitForSignIn(owner, signIn, config, device);
    return current;
  }

  async function disconnect(owner: string): Promise<CodexConnectionState> {
    cancel(owner);
    await vault.clear(owner);
    return publish(owner);
  }

  async function listModels(
    owner: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const response = await authorizedFetch(owner)(
      `${resolveConfig().codexBaseUrl}/models`,
      { method: 'GET', headers: { accept: 'application/json' }, signal },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new CodexAuthError(
        'models-request-failed',
        `Listing ChatGPT models failed (${response.status}).`,
      );
    }
    return extractCodexModelSlugs(await response.json());
  }

  return {
    /** AI SDK models authenticated as this owner's ChatGPT account. */
    provider: (owner: string) => codexProvider(authorizedFetch(owner)),
    /** Model slugs this owner's account can run. */
    listModels,
    state,
    connect,
    /** Abandons an in-flight sign-in, for example when the owner signs out. */
    cancel,
    disconnect,
  };
}

export type CodexAccounts = ReturnType<typeof createCodexAccounts>;

function pending(signIn: PendingSignIn): CodexConnectionState {
  return {
    status: 'pending',
    userCode: signIn.userCode,
    verificationUrl: signIn.verificationUrl,
    expiresAt: signIn.expiresAt,
  };
}

function codexAuth(tokens: ChatGPTTokens): CodexAuth {
  const accountId =
    tokens.accountId ??
    deriveAccountId(tokens.idToken) ??
    deriveAccountId(tokens.accessToken);
  if (!accountId) {
    throw new CodexAuthError(
      'missing-account-id',
      'The ChatGPT connection has no account identifier. Connect the account again.',
    );
  }
  return { accessToken: tokens.accessToken, accountId };
}

async function refreshTokens(
  current: ChatGPTTokens,
): Promise<RefreshResult<ChatGPTTokens>> {
  const config = resolveConfig({
    fetch: (input, init) =>
      globalThis.fetch(input, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
  });
  try {
    return {
      status: 'refreshed',
      tokens: await ensureFreshTokens(config, current, { force: true }),
    };
  } catch (error) {
    if (isRefreshTokenInvalid(error)) return { status: 'revoked' };
    // The library keeps token endpoint bodies on the error; never forward them.
    throw new CodexAuthError(
      'refresh-failed',
      'Could not refresh the ChatGPT connection. Retry the request.',
    );
  }
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
