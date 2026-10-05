import { MemoryStore } from '@opencoredev/loginwithchatgpt-core';
import { generateText } from 'ai';
import nock from 'nock';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  ClaudeAuthError,
  type ClaudeConnectionState,
  createClaudeAccounts,
} from '@deepagents/experimental/providers/claude';

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

const ORIGINS = ['https://platform.claude.com', 'https://api.anthropic.com'];

interface WireRequest {
  url: string;
  authorization: string | null;
  apiKey: string | null;
  body: Record<string, any> | undefined;
}

function interceptWire(
  handle: (request: WireRequest) => Response | Promise<Response>,
) {
  const requests: WireRequest[] = [];
  nock.disableNetConnect();
  for (const origin of ORIGINS) {
    for (const method of ['GET', 'POST']) {
      nock(origin)
        .persist()
        .intercept(() => true, method)
        .reply(async function (uri, body) {
          const wire: WireRequest = {
            url: origin + uri,
            authorization: this.req.headers.authorization ?? null,
            apiKey: this.req.headers['x-api-key'] ?? null,
            body: typeof body === 'object' ? body : undefined,
          };
          requests.push(wire);
          const response = await handle(wire);
          return [
            response.status,
            Buffer.from(await response.arrayBuffer()),
            Object.fromEntries(response.headers),
          ];
        });
    }
  }
  return Object.assign(requests, {
    [Symbol.dispose]: () => {
      nock.cleanAll();
      nock.enableNetConnect();
    },
  });
}

function unexpected(request: WireRequest): never {
  throw new Error(`Unexpected request to ${request.url}`);
}

function tokens(
  accessToken: string,
  refreshToken: string,
  extra: Record<string, unknown> = {},
) {
  return Response.json({
    token_type: 'Bearer',
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    scope: 'user:profile user:inference',
    account: { email_address: 'ada@example.com' },
    ...extra,
  });
}

function message(text: string) {
  return Response.json({
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 4 },
  });
}

async function signIn(
  accounts: ReturnType<typeof createClaudeAccounts>,
  owner: string,
) {
  const pending = await accounts.connect(owner);
  assert.ok(pending.status === 'pending');
  const state = new URL(pending.authorizationUrl).searchParams.get('state');
  return accounts.complete(owner, `code-${owner}#${state}`);
}

function ask(accounts: ReturnType<typeof createClaudeAccounts>, owner: string) {
  return generateText({
    model: accounts.provider(owner)('claude-sonnet-4-6'),
    prompt: 'hello',
    maxRetries: 0,
  });
}

test('signing in with the pasted code connects the account and authenticates its models', async () => {
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => changes.push(state),
  });
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected(request);
  });

  const pending = await accounts.connect('owner-a');
  assert.ok(pending.status === 'pending');
  const authorization = new URL(pending.authorizationUrl);
  const connected = await accounts.complete(
    'owner-a',
    `pasted-code#${authorization.searchParams.get('state')}`,
  );
  const result = await ask(accounts, 'owner-a');

  assert.deepStrictEqual(connected, {
    status: 'connected',
    user: { email: 'ada@example.com' },
  });
  assert.deepStrictEqual(
    changes.map((change) => change.status),
    ['pending', 'connected'],
  );
  const exchange = requests.find((request) => request.url === TOKEN_URL)?.body;
  assert.equal(exchange?.grant_type, 'authorization_code');
  assert.equal(exchange?.code, 'pasted-code');
  assert.equal(exchange?.state, authorization.searchParams.get('state'));
  assert.equal(
    exchange?.client_id,
    authorization.searchParams.get('client_id'),
  );
  assert.equal(
    exchange?.redirect_uri,
    authorization.searchParams.get('redirect_uri'),
  );
  assert.equal(
    createHash('sha256').update(exchange?.code_verifier).digest('base64url'),
    authorization.searchParams.get('code_challenge'),
  );
  assert.equal(result.text, 'hi');
  const modelRequest = requests.find((request) => request.url === MESSAGES_URL);
  assert.equal(modelRequest?.authorization, 'Bearer access-1');
  assert.equal(modelRequest?.apiKey, null);
  assert.equal(
    modelRequest?.body?.system[0].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
});

test('a code from another sign-in attempt keeps the sign-in pending without contacting Anthropic', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    return unexpected(request);
  });

  const pending = await accounts.connect('owner-a');
  assert.ok(pending.status === 'pending');
  const rejected = await accounts.complete(
    'owner-a',
    'pasted-code#other-attempt',
  );
  const accepted = await accounts.complete(
    'owner-a',
    `https://platform.claude.com/oauth/code/callback?code=pasted-code&state=${new URL(pending.authorizationUrl).searchParams.get('state')}`,
  );

  assert.equal(rejected.status, 'pending');
  assert.match(
    rejected.status === 'pending' ? (rejected.message ?? '') : '',
    /another sign-in attempt/,
  );
  assert.equal(accepted.status, 'connected');
  assert.equal(requests.length, 1);
});

test('Anthropic throttling keeps the sign-in retryable', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  let exchanges = 0;
  using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected(request);
    exchanges++;
    return exchanges === 1
      ? new Response('slow down', { status: 429 })
      : tokens('access-1', 'refresh-1');
  });

  const throttled = await signIn(accounts, 'owner-a');
  const pending = await accounts.state('owner-a');
  assert.ok(pending.status === 'pending');
  const connected = await accounts.complete(
    'owner-a',
    `pasted-code#${new URL(pending.authorizationUrl).searchParams.get('state')}`,
  );

  assert.equal(throttled.status, 'pending');
  assert.equal(connected.status, 'connected');
});

test('a rejected code ends the sign-in without exposing the response body', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected(request);
    return Response.json(
      { error: 'invalid_grant', error_description: 'secret-exchange-detail' },
      { status: 400 },
    );
  });

  const failed = await signIn(accounts, 'owner-a');
  const after = await accounts.state('owner-a');

  assert.equal(failed.status, 'error');
  assert.doesNotMatch(JSON.stringify(failed), /secret-exchange-detail/);
  assert.deepStrictEqual(after, { status: 'unauthenticated' });
});

test('disconnecting while the code exchange is in flight saves nothing', async () => {
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => changes.push(state),
  });
  const exchanging = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  using _wire = interceptWire(async (request) => {
    if (request.url !== TOKEN_URL) return unexpected(request);
    exchanging.resolve();
    await release.promise;
    return tokens('access-1', 'refresh-1');
  });

  const completing = signIn(accounts, 'owner-a');
  await exchanging.promise;
  await accounts.disconnect('owner-a');
  release.resolve();
  const settled = await completing;

  assert.deepStrictEqual(settled, { status: 'unauthenticated' });
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
  assert.ok(changes.every((change) => change.status !== 'error'));
});

test('concurrent requests on an expiring token refresh once and keep the account connected', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  let validRefreshToken = 'refresh-1';
  let refreshes = 0;
  using requests = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', { expires_in: 30 });
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      // Anthropic rotates refresh tokens: a second use of the old one fails.
      if (request.body?.refresh_token !== validRefreshToken) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      validRefreshToken = 'refresh-2';
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const results = await Promise.all([
    ask(accounts, 'owner-a'),
    ask(accounts, 'owner-a'),
    ask(accounts, 'owner-a'),
  ]);

  assert.deepStrictEqual(
    results.map((result) => result.text),
    ['hi', 'hi', 'hi'],
  );
  assert.equal(refreshes, 1);
  assert.deepStrictEqual(
    requests
      .filter((request) => request.url === MESSAGES_URL)
      .map((request) => request.authorization),
    ['Bearer access-2', 'Bearer access-2', 'Bearer access-2'],
  );
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('a revoked refresh token disconnects the account and reports it', async () => {
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => changes.push(state),
  });
  using _wire = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', { expires_in: 30 });
    }
    if (request.url === TOKEN_URL) {
      return Response.json(
        { error: 'invalid_grant', error_description: 'secret-refresh-detail' },
        { status: 400 },
      );
    }
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);

  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'refresh-token-invalid');
  assert.doesNotMatch(failure.message, /secret-refresh-detail/);
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
  assert.deepStrictEqual(changes.at(-1), { status: 'unauthenticated' });
});

test('a failed refresh keeps the account and hides the token endpoint body', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  let refreshes = 0;
  using _wire = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', { expires_in: 30 });
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      return refreshes === 1
        ? new Response('secret-outage-detail', { status: 503 })
        : tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) return message('recovered');
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);
  const retried = await ask(accounts, 'owner-a');

  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'refresh-failed');
  assert.doesNotMatch(failure.message, /secret-outage-detail/);
  assert.equal(retried.text, 'recovered');
});

test('a rejected access token is refreshed once and the request retried', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  let refreshes = 0;
  using requests = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1');
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) {
      return request.authorization === 'Bearer access-1'
        ? Response.json({ type: 'error' }, { status: 401 })
        : message('after refresh');
    }
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const result = await ask(accounts, 'owner-a');

  assert.equal(result.text, 'after refresh');
  assert.equal(refreshes, 1);
  assert.deepStrictEqual(
    requests
      .filter((request) => request.url === MESSAGES_URL)
      .map((request) => request.authorization),
    ['Bearer access-1', 'Bearer access-2'],
  );
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('an access token still rejected after refresh fails the request but keeps the account', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using _wire = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1');
    }
    if (request.url === TOKEN_URL) return tokens('access-2', 'refresh-2');
    if (request.url === MESSAGES_URL) {
      return Response.json({ type: 'error' }, { status: 401 });
    }
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);

  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'access-token-invalid');
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('a refresh finishing after a disconnect cannot reconnect the account', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  using _wire = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', { expires_in: 30 });
    }
    if (request.url === TOKEN_URL) {
      refreshing.resolve();
      await release.promise;
      return tokens('access-2', 'refresh-2');
    }
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  const asking = ask(accounts, 'owner-a').catch((error) => error);
  await refreshing.promise;
  await accounts.disconnect('owner-a');
  release.resolve();
  const failure = await asking;

  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'not-connected');
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
});

test('models are listed across every page for the connected account', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    const url = new URL(request.url);
    if (url.origin + url.pathname !== 'https://api.anthropic.com/v1/models') {
      return unexpected(request);
    }
    return url.searchParams.get('after_id') === 'claude-sonnet-5-5'
      ? Response.json({
          data: [{ type: 'model', id: 'claude-haiku-4-5-20251001' }],
          has_more: false,
          first_id: 'claude-haiku-4-5-20251001',
          last_id: 'claude-haiku-4-5-20251001',
        })
      : Response.json({
          data: [
            { type: 'model', id: 'claude-opus-5-5' },
            { type: 'model', id: 'claude-sonnet-5-5' },
          ],
          has_more: true,
          first_id: 'claude-opus-5-5',
          last_id: 'claude-sonnet-5-5',
        });
  });

  await signIn(accounts, 'owner-a');
  const models = await accounts.listModels('owner-a');

  assert.deepStrictEqual(models, [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
  ]);
  assert.ok(
    requests
      .filter((request) =>
        request.url.startsWith('https://api.anthropic.com/v1/models'),
      )
      .every((request) => request.authorization === 'Bearer access-1'),
  );
});

test('a profile outage keeps the connection and a later read fills in the identity', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  let profileAvailable = false;
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      return tokens('access-1', 'refresh-1', { account: undefined });
    }
    if (request.url === PROFILE_URL) {
      return profileAvailable
        ? Response.json({
            account: { email: 'ada@example.com', display_name: 'Ada' },
            organization: { name: 'Analytical Engines' },
          })
        : new Response('unavailable', { status: 503 });
    }
    return unexpected(request);
  });

  const duringOutage = await signIn(accounts, 'owner-a');
  profileAvailable = true;
  const recovered = await accounts.state('owner-a');

  assert.deepStrictEqual(duringOutage, { status: 'connected', user: null });
  assert.deepStrictEqual(recovered, {
    status: 'connected',
    user: { email: 'ada@example.com', name: 'Ada' },
  });
  assert.equal(
    requests.findLast((request) => request.url === PROFILE_URL)?.authorization,
    'Bearer access-1',
  );
});

test('each owner authenticates with its own account', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      const owner = String(request.body?.code).replace('code-', '');
      return tokens(`access-${owner}`, `refresh-${owner}`);
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  await signIn(accounts, 'owner-b');
  await ask(accounts, 'owner-a');
  await ask(accounts, 'owner-b');
  await accounts.disconnect('owner-a');

  assert.deepStrictEqual(
    requests
      .filter((request) => request.url === MESSAGES_URL)
      .map((request) => request.authorization),
    ['Bearer access-owner-a', 'Bearer access-owner-b'],
  );
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
  assert.equal((await accounts.state('owner-b')).status, 'connected');
});

test('owners sign in independently at the same time', async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected(request);
    const owner = String(request.body?.code).replace('code-', '');
    return tokens(`access-${owner}`, `refresh-${owner}`, {
      account: { email_address: `${owner}@example.com` },
    });
  });

  const first = await accounts.connect('owner-a');
  const second = await accounts.connect('owner-b');
  assert.ok(first.status === 'pending' && second.status === 'pending');
  const connectedB = await accounts.complete(
    'owner-b',
    `code-owner-b#${new URL(second.authorizationUrl).searchParams.get('state')}`,
  );
  const connectedA = await accounts.complete(
    'owner-a',
    `code-owner-a#${new URL(first.authorizationUrl).searchParams.get('state')}`,
  );

  assert.deepStrictEqual(connectedA, {
    status: 'connected',
    user: { email: 'owner-a@example.com' },
  });
  assert.deepStrictEqual(connectedB, {
    status: 'connected',
    user: { email: 'owner-b@example.com' },
  });
});

test("disconnecting one owner does not disturb another owner's refresh", async () => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let validRefreshToken = 'refresh-owner-b';
  let refreshes = 0;
  using _wire = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      const owner = String(request.body?.code).replace('code-', '');
      return tokens(`access-${owner}`, `refresh-${owner}`, {
        expires_in: owner === 'owner-b' ? 30 : 3600,
      });
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      if (request.body?.refresh_token !== validRefreshToken) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      validRefreshToken = 'refresh-owner-b-2';
      refreshing.resolve();
      await release.promise;
      return tokens('access-owner-b-2', 'refresh-owner-b-2');
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected(request);
  });

  await signIn(accounts, 'owner-a');
  await signIn(accounts, 'owner-b');
  const asking = ask(accounts, 'owner-b');
  await refreshing.promise;
  await accounts.disconnect('owner-a');
  release.resolve();
  const result = await asking;

  assert.equal(result.text, 'hi');
  assert.equal(refreshes, 1);
  assert.equal((await accounts.state('owner-b')).status, 'connected');
});

test('a sign-in abandoned during the code exchange cannot report over a new sign-in', async () => {
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => changes.push(state),
  });
  const exchanging = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  using _wire = interceptWire(async (request) => {
    if (request.url !== TOKEN_URL) return unexpected(request);
    exchanging.resolve();
    await release.promise;
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  });

  const abandoned = signIn(accounts, 'owner-a');
  await exchanging.promise;
  await accounts.disconnect('owner-a');
  const restarted = await accounts.connect('owner-a');
  release.resolve();
  await abandoned;

  assert.ok(restarted.status === 'pending');
  assert.deepStrictEqual(await accounts.state('owner-a'), restarted);
  assert.deepStrictEqual(
    changes.filter((change) => change.status !== 'unauthenticated'),
    [changes[0], restarted],
  );
});

test('an abandoned sign-in expires after ten minutes', async (t) => {
  const accounts = createClaudeAccounts({ store: new MemoryStore() });
  using requests = interceptWire(unexpected);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

  const pending = await accounts.connect('owner-a');
  assert.ok(pending.status === 'pending');
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  const expired = await accounts.complete(
    'owner-a',
    `pasted-code#${new URL(pending.authorizationUrl).searchParams.get('state')}`,
  );

  assert.equal(expired.status, 'error');
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
  assert.equal(requests.length, 0);
});

test('unreadable stored tokens read as a disconnected account', async () => {
  const store = new MemoryStore<any>();
  // A blob written by an older or broken writer of the caller's store.
  store.set('owner-a', { apiKey: 'not-a-subscription' });
  const accounts = createClaudeAccounts({ store });
  using _wire = interceptWire(unexpected);

  const state = await accounts.state('owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);

  assert.deepStrictEqual(state, { status: 'unauthenticated' });
  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'not-connected');
});

test('a store that cannot save ends the sign-in with an error instead of throwing', async () => {
  const memory = new MemoryStore<any>();
  // The caller's encrypted storage can be unavailable (Linux basic_text).
  const store = {
    get: (key: string) => memory.get(key),
    set: () => {
      throw new Error('Secure storage is unavailable on this system.');
    },
    delete: (key: string) => memory.delete(key),
  };
  const accounts = createClaudeAccounts({ store });
  using _wire = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    return unexpected(request);
  });

  const completed = await signIn(accounts, 'owner-a');

  assert.deepStrictEqual(completed, {
    status: 'error',
    message: 'Secure storage is unavailable on this system.',
  });
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
});
