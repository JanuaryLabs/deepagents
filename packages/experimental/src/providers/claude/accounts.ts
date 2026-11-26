import { hash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  type RefreshResult,
  createTokenResolver,
  retryUnauthorized,
} from '../account-tokens.ts';
import type { PostgresAccountStore } from '../postgres-account-store.ts';
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
const PROVIDER = 'claude';

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
const pendingSignIn = z.object({
  authorizationUrl: z.string(),
  verifier: z.string(),
  message: z.string().optional(),
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
  /** Holds each owner's tokens and sign-ins, shared by every instance on the database. */
  store: PostgresAccountStore;
  /** An entry gives `globalThis`; a test gives `createClock()`. */
  clock: { Date: { now(): number } };
  /** Receives every connection change, including a revoked refresh token. */
  onChange?: (owner: string, state: ClaudeConnectionState) => void;
}

interface PendingSignIn extends z.infer<typeof pendingSignIn> {
  state: string;
  fence: bigint;
  expiresAt: number;
}

/**
 * Claude Pro/Max subscriptions owned by the application rather than the local
 * Claude Code login: PKCE sign-in, refresh, and models per owner. Every
 * instance on one store's database shares the accounts: a sign-in started on
 * one host finishes on another, and one host refreshes an owner at a time.
 */
export function createClaudeAccounts(options: ClaudeAccountsOptions) {
  const { clock, store } = options;
  const parse = (value: unknown) => claudeTokens.safeParse(value).data;
  // The code exchanges this process runs, by sign-in state, so a cancel here
  // stops the request in flight and waits for its report; a cancel elsewhere
  // makes its save fail.
  const exchanges = new Map<
    string,
    { abort: AbortController; settled: Promise<unknown> }
  >();
  const tokens = createTokenResolver<ClaudeTokens>({
    store,
    provider: PROVIDER,
    parse,
    isFresh: (current) =>
      current.expiresAt > clock.Date.now() + EXPIRY_MARGIN_MS,
    refresh: (current, signal) => refreshTokens(current, clock, signal),
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

  async function readSignIn(owner: string): Promise<PendingSignIn | undefined> {
    const stored = await store.signIn(PROVIDER, owner);
    return (
      stored && {
        ...pendingSignIn.parse(stored.pending),
        state: stored.state,
        fence: stored.fence,
        expiresAt: stored.expiresAt,
      }
    );
  }

  async function state(owner: string): Promise<ClaudeConnectionState> {
    try {
      const signIn = await readSignIn(owner);
      if (signIn) {
        if (signIn.expiresAt > clock.Date.now()) return pending(signIn);
        // Not awaited: this read can run inside that sign-in's own exchange.
        void abandon(await store.takeSignIn(PROVIDER, owner));
      }
      const account = await store.account(PROVIDER, owner);
      const current = parse(account.tokens);
      if (!current) return { status: 'unauthenticated' };
      if (current.user) return { status: 'connected', user: current.user };
      // Identity is display-only and fetched lazily, so a profile outage never
      // breaks a working connection; the next read retries.
      const user = await fetchProfile(current.accessToken);
      if (!user) return { status: 'connected', user: null };
      if (
        await store.exclusive(PROVIDER, owner, (lease) =>
          lease.writeIfUnchanged({ ...current, user }, account.fence),
        )
      ) {
        return { status: 'connected', user };
      }
      const latest = parse((await store.account(PROVIDER, owner)).tokens);
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

  /** Aborts this process's exchange of an ended sign-in; settles once it reported. */
  function abandon(ended: string | undefined) {
    const running = ended === undefined ? undefined : exchanges.get(ended);
    running?.abort.abort();
    return running?.settled;
  }

  async function cancel(owner: string) {
    await abandon(await store.takeSignIn(PROVIDER, owner));
  }

  // Cancel and disconnect abort the code exchange, so an abandoned sign-in
  // ends in one of these two; it reports the current state instead of its
  // own, so it can never speak over or cancel a newer sign-in.
  async function keepPending(
    owner: string,
    signIn: PendingSignIn,
    message: string,
  ) {
    const shown = { ...signIn, message };
    if (
      !(await store.updateSignIn(
        PROVIDER,
        owner,
        signIn.state,
        pendingValue(shown),
      ))
    ) {
      return publish(owner);
    }
    return emit(owner, pending(shown));
  }

  async function fail(owner: string, signIn: PendingSignIn, message: string) {
    if (!(await store.takeSignIn(PROVIDER, owner, signIn.state))) {
      return publish(owner);
    }
    return emit(owner, { status: 'error', message });
  }

  async function connect(owner: string): Promise<ClaudeConnectionState> {
    const existing = await state(owner);
    if (existing.status !== 'unauthenticated') return existing;
    const { fence } = await store.account(PROVIDER, owner);

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
      hash('sha256', verifier, 'base64url'),
    );
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', oauthState);

    await cancel(owner);
    await store.beginSignIn(PROVIDER, owner, {
      state: oauthState,
      pending: pendingValue({ authorizationUrl: url.href, verifier }),
      fence,
      expiresAt: clock.Date.now() + SIGN_IN_TIMEOUT_MS,
    });
    return publish(owner);
  }

  async function complete(
    owner: string,
    input: string,
  ): Promise<ClaudeConnectionState> {
    const signIn = await readSignIn(owner);
    if (!signIn || signIn.expiresAt <= clock.Date.now()) {
      await cancel(owner);
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

    if (signIn.message) {
      signIn.message = undefined;
      await store.updateSignIn(
        PROVIDER,
        owner,
        signIn.state,
        pendingValue(signIn),
      );
    }
    const abort = new AbortController();
    const exchanging = exchange(owner, signIn, callback, abort.signal);
    const running = { abort, settled: Promise.allSettled([exchanging]) };
    exchanges.set(signIn.state, running);
    try {
      return await exchanging;
    } finally {
      if (exchanges.get(signIn.state) === running) {
        exchanges.delete(signIn.state);
      }
    }
  }

  async function exchange(
    owner: string,
    signIn: PendingSignIn,
    callback: { code: string; state: string },
    signal: AbortSignal,
  ): Promise<ClaudeConnectionState> {
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
          signal,
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
      await response.json().catch((error: unknown) => {
        // A body that is not JSON fails the schema below.
        if (error instanceof SyntaxError) return undefined;
        throw error;
      }),
    );
    if (!parsed.data?.refresh_token) {
      return fail(
        owner,
        signIn,
        'Anthropic returned an invalid sign-in response.',
      );
    }

    const email = parsed.data.account?.email_address;
    const connected: ClaudeTokens = {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt: clock.Date.now() + parsed.data.expires_in * 1000,
      ...(email && { user: { email } }),
    };
    try {
      await store.exclusive(PROVIDER, owner, (lease) =>
        lease.finishSignIn(signIn.state, connected, clock.Date.now()),
      );
    } catch (error) {
      return fail(
        owner,
        signIn,
        messageOf(error, 'Saving the Claude connection failed.'),
      );
    }
    return publish(owner);
  }

  async function disconnect(owner: string): Promise<ClaudeConnectionState> {
    const ended = await store.disconnect(PROVIDER, owner);
    await abandon(ended);
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

function pendingValue({
  authorizationUrl,
  verifier,
  message,
}: z.infer<typeof pendingSignIn>): z.infer<typeof pendingSignIn> {
  return { authorizationUrl, verifier, ...(message && { message }) };
}

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
  clock: ClaudeAccountsOptions['clock'],
  signal: AbortSignal,
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
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
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
    await response.json().catch((error: unknown) => {
      // A body that is not JSON fails the schema below.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }),
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
      expiresAt: clock.Date.now() + parsed.data.expires_in * 1000,
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
  return Error.isError(error) ? error.message : fallback;
}
