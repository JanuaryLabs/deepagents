import type { KeyValueStore } from '@opencoredev/loginwithchatgpt-core';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  type RefreshResult,
  createTokenResolver,
  createTokenVault,
  retryUnauthorized,
} from '../account-tokens.ts';
import { requestSignal } from '../request-signal.ts';
import { ClaudeAuthError } from './errors.ts';
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from './oauth.ts';
import { claudeProvider, withBearer } from './provider.ts';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CALLBACK_URL = 'https://platform.claude.com/oauth/code/callback';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const MODELS_URL = 'https://api.anthropic.com/v1/models';
const SCOPES = ['user:profile', 'user:inference'];
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PROFILE_TIMEOUT_MS = 10_000;
const EXPIRY_MARGIN_MS = 60_000;

const claudeUser = z.object({
  email: z.string(),
  name: z.string().optional(),
});
const claudeTokens = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  user: claudeUser.optional(),
});
const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  account: z.object({ email_address: z.string().optional() }).optional(),
});
const profileResponse = z.object({
  account: z.object({
    email: z.string(),
    display_name: z.string().optional(),
  }),
});
const modelsPage = z.object({
  data: z.array(z.object({ id: z.string() })),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});

export type ClaudeUser = z.infer<typeof claudeUser>;
export type ClaudeTokens = z.infer<typeof claudeTokens>;

export type ClaudeConnectionState =
  | { status: 'unauthenticated' }
  | {
      status: 'pending';
      authorizationUrl: string;
      expiresAt: string;
      message?: string;
    }
  | { status: 'connected'; user: ClaudeUser | null }
  | { status: 'error'; message: string };

export interface ClaudeAccountsOptions {
  /** Holds each owner's tokens, keyed by the owner passed to every method. */
  store: KeyValueStore<ClaudeTokens>;
  /** Receives every connection change, including a revoked refresh token. */
  onChange?: (owner: string, state: ClaudeConnectionState) => void;
}

interface PendingSignIn {
  authorizationUrl: string;
  verifier: string;
  state: string;
  expiresAt: number;
  revision: number;
  abort: AbortController;
  message?: string;
}

/**
 * Claude Pro/Max subscriptions owned by the application rather than the local
 * Claude Code login: PKCE sign-in, refresh, and models per owner. Create one
 * instance per store; refresh serialization lives in the instance.
 */
export function createClaudeAccounts(options: ClaudeAccountsOptions) {
  const vault = createTokenVault(
    options.store,
    (value) => claudeTokens.safeParse(value).data,
  );
  const signIns = new Map<string, PendingSignIn>();
  const tokens = createTokenResolver<ClaudeTokens>({
    vault,
    isFresh: (current) => current.expiresAt > Date.now() + EXPIRY_MARGIN_MS,
    refresh: refreshTokens,
    notConnected: () =>
      new ClaudeAuthError(
        'not-connected',
        'No Claude account is connected. Connect one before using this model.',
      ),
    revoked: () =>
      new ClaudeAuthError(
        'refresh-token-invalid',
        'The Claude connection expired or was revoked. Connect the account again.',
      ),
    conflicted: () =>
      new ClaudeAuthError(
        'refresh-failed',
        'The Claude connection changed repeatedly during refresh. Retry the request.',
      ),
    onRevoked: (owner) => void publish(owner),
  });

  function authorizedFetch(owner: string): typeof globalThis.fetch {
    return async (input, init) => {
      const signal = requestSignal(input, init);
      const current = await tokens.fresh(owner, signal);
      return retryUnauthorized(
        current.accessToken,
        (token) => globalThis.fetch(input, withBearer(init, token)),
        async (rejected) =>
          (await tokens.replace(owner, rejected, signal)).accessToken,
        () =>
          new ClaudeAuthError(
            'access-token-invalid',
            'Anthropic rejected the Claude connection. Connect the account again.',
          ),
      );
    };
  }

  async function state(owner: string): Promise<ClaudeConnectionState> {
    const signIn = signIns.get(owner);
    if (signIn) {
      if (signIn.expiresAt > Date.now()) return pending(signIn);
      cancel(owner);
    }
    try {
      const snapshot = await vault.snapshot(owner);
      if (!snapshot.tokens) return { status: 'unauthenticated' };
      if (snapshot.tokens.user) {
        return { status: 'connected', user: snapshot.tokens.user };
      }
      // Identity is display-only and fetched lazily, so a profile outage never
      // breaks a working connection; the next read retries.
      const user = await fetchProfile(snapshot.tokens.accessToken);
      if (!user) return { status: 'connected', user: null };
      if (
        await vault.commit(
          owner,
          { ...snapshot.tokens, user },
          snapshot.revision,
        )
      ) {
        return { status: 'connected', user };
      }
      const latest = (await vault.snapshot(owner)).tokens;
      return latest
        ? { status: 'connected', user: latest.user ?? null }
        : { status: 'unauthenticated' };
    } catch (error) {
      return {
        status: 'error',
        message: messageOf(error, 'Reading the Claude connection failed.'),
      };
    }
  }

  function emit(owner: string, current: ClaudeConnectionState) {
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

  // Cancel and disconnect abort the code exchange, so an abandoned sign-in
  // ends in one of these two; it reports the current state instead of its
  // own, so it can never speak over or cancel a newer sign-in.
  async function keepPending(
    owner: string,
    signIn: PendingSignIn,
    message: string,
  ) {
    if (signIns.get(owner) !== signIn) return publish(owner);
    signIn.message = message;
    return emit(owner, pending(signIn));
  }

  async function fail(owner: string, signIn: PendingSignIn, message: string) {
    if (signIns.get(owner) !== signIn) return publish(owner);
    cancel(owner);
    return emit(owner, { status: 'error', message });
  }

  async function connect(owner: string): Promise<ClaudeConnectionState> {
    const existing = await state(owner);
    if (existing.status !== 'unauthenticated') return existing;
    const { revision } = await vault.snapshot(owner);

    const verifier = randomBytes(64).toString('base64url');
    const oauthState = randomUUID().replaceAll('-', '');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', CALLBACK_URL);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set(
      'code_challenge',
      createHash('sha256').update(verifier).digest('base64url'),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', oauthState);

    cancel(owner);
    signIns.set(owner, {
      authorizationUrl: url.href,
      verifier,
      state: oauthState,
      expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS,
      revision,
      abort: new AbortController(),
    });
    return publish(owner);
  }

  async function complete(
    owner: string,
    input: string,
  ): Promise<ClaudeConnectionState> {
    const signIn = signIns.get(owner);
    if (!signIn || signIn.expiresAt <= Date.now()) {
      cancel(owner);
      return emit(owner, {
        status: 'error',
        message: 'Claude sign-in expired. Start the connection again.',
      });
    }
    const callback = parseCallback(input);
    if (!callback || callback.state !== signIn.state) {
      return keepPending(
        owner,
        signIn,
        'That authorization code is invalid or belongs to another sign-in attempt.',
      );
    }

    signIn.message = undefined;
    let response: Response;
    try {
      response = await globalThis.fetch(CLAUDE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          code: callback.code,
          state: callback.state,
          grant_type: 'authorization_code',
          client_id: CLAUDE_CLIENT_ID,
          redirect_uri: CALLBACK_URL,
          code_verifier: signIn.verifier,
        }),
        signal: AbortSignal.any([
          signIn.abort.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
    } catch {
      return keepPending(
        owner,
        signIn,
        'Could not reach Anthropic to finish sign-in. Try again.',
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Token endpoint bodies stay out of messages: they can echo credentials.
      const message = `Anthropic rejected the authorization code (${response.status}).`;
      return response.status === 429 || response.status >= 500
        ? keepPending(owner, signIn, `${message} Try again.`)
        : fail(owner, signIn, message);
    }
    const parsed = tokenResponse.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!parsed.data?.refresh_token) {
      return fail(
        owner,
        signIn,
        'Anthropic returned an invalid sign-in response.',
      );
    }

    const email = parsed.data.account?.email_address;
    try {
      await vault.commit(
        owner,
        {
          accessToken: parsed.data.access_token,
          refreshToken: parsed.data.refresh_token,
          expiresAt: Date.now() + parsed.data.expires_in * 1000,
          ...(email && { user: { email } }),
        },
        signIn.revision,
      );
    } catch (error) {
      return fail(
        owner,
        signIn,
        messageOf(error, 'Saving the Claude connection failed.'),
      );
    }
    if (signIns.get(owner) === signIn) signIns.delete(owner);
    return publish(owner);
  }

  async function disconnect(owner: string): Promise<ClaudeConnectionState> {
    cancel(owner);
    await vault.clear(owner);
    return publish(owner);
  }

  async function listModels(
    owner: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const fetch = authorizedFetch(owner);
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const url = new URL(MODELS_URL);
      url.searchParams.set('limit', '1000');
      if (after) url.searchParams.set('after_id', after);
      const response = await fetch(url, {
        headers: {
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ClaudeAuthError(
          'models-request-failed',
          `Listing Claude models failed (${response.status}).`,
        );
      }
      const page = modelsPage.safeParse(await response.json());
      if (!page.success) {
        throw new ClaudeAuthError(
          'models-request-failed',
          'Anthropic returned an invalid model list.',
        );
      }
      ids.push(...page.data.data.map((model) => model.id));
      after = page.data.has_more ? (page.data.last_id ?? undefined) : undefined;
    } while (after);
    return ids;
  }

  return {
    /** AI SDK models authenticated as this owner's Claude account. */
    provider: (owner: string) => claudeProvider(authorizedFetch(owner)),
    /** Model ids this owner's account can run, from Anthropic's model list. */
    listModels,
    state,
    /** Starts PKCE sign-in; open the returned `authorizationUrl` for the user. */
    connect,
    /** Finishes sign-in with the code, `code#state`, or callback URL Claude shows. */
    complete,
    /** Abandons an in-flight sign-in, for example when the owner signs out. */
    cancel,
    disconnect,
  };
}

export type ClaudeAccounts = ReturnType<typeof createClaudeAccounts>;

function pending(signIn: PendingSignIn): ClaudeConnectionState {
  return {
    status: 'pending',
    authorizationUrl: signIn.authorizationUrl,
    expiresAt: new Date(signIn.expiresAt).toISOString(),
    ...(signIn.message && { message: signIn.message }),
  };
}

async function refreshTokens(
  current: ClaudeTokens,
): Promise<RefreshResult<ClaudeTokens>> {
  let response: Response;
  try {
    response = await globalThis.fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ClaudeAuthError(
      'refresh-failed',
      'Could not reach Anthropic to refresh the Claude connection. Retry the request.',
    );
  }
  if (response.status === 400 || response.status === 401) {
    await response.body?.cancel();
    return { status: 'revoked' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ClaudeAuthError(
      'refresh-failed',
      `Anthropic could not refresh the Claude connection (${response.status}). Retry the request.`,
    );
  }
  const parsed = tokenResponse.safeParse(
    await response.json().catch(() => undefined),
  );
  if (!parsed.success) {
    throw new ClaudeAuthError(
      'invalid-token-response',
      'Anthropic returned an invalid token refresh response.',
    );
  }
  return {
    status: 'refreshed',
    tokens: {
      ...current,
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    },
  };
}

async function fetchProfile(
  accessToken: string,
): Promise<ClaudeUser | undefined> {
  try {
    const response = await globalThis.fetch(PROFILE_URL, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const profile = profileResponse.safeParse(await response.json());
    if (!profile.success) return undefined;
    const { email, display_name: name } = profile.data.account;
    return name ? { email, name } : { email };
  } catch {
    return undefined;
  }
}

function parseCallback(input: string) {
  const trimmed = input.trim();
  if (URL.canParse(trimmed)) {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (code && state) return { code, state };
  }
  const [code, state, extra] = trimmed.split('#');
  if (code && state && extra === undefined) return { code, state };
  const query = new URLSearchParams(trimmed);
  const queryCode = query.get('code');
  const queryState = query.get('state');
  return queryCode && queryState
    ? { code: queryCode, state: queryState }
    : undefined;
}

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
