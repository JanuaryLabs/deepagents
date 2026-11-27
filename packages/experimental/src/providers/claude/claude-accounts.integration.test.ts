import { createClock } from '@sinonjs/fake-timers';
import { untilAborted } from '@zukhruf/async';
import { waitFor } from '@zukhruf/testing/async';
import { Msw } from '@zukhruf/testing/msw';
import { Postgres } from '@zukhruf/testing/postgres';
import { generateText } from 'ai';
import { http } from 'msw';
import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

import {
  ClaudeAuthError,
  type ClaudeConnectionState,
  PostgresAccountStore,
  createClaudeAccounts,
} from '@deepagents/experimental/providers/claude';

const testPostgres = new Postgres({ environment: process.env });

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

/**
 * msw passes some connections through to the real network (a socket that
 * sends nothing first, a request it cannot attribute to fetch, any connection
 * after close()) and keeps them after close(), so undici's global pool can
 * hand one to a later test. A pool here resolves no real address, so such a
 * connection fails instead of reaching Anthropic (msw resolves its own mocked
 * connections), and each test ends with a fresh pool.
 */
function offlinePool() {
  return new Agent({
    connect: {
      lookup: (hostname, _options, callback) =>
        callback(new Error(`A test request escaped msw to ${hostname}`), ''),
    },
  });
}

async function replaceGlobalPool() {
  const pool = getGlobalDispatcher();
  setGlobalDispatcher(offlinePool());
  await pool.destroy();
}

setGlobalDispatcher(offlinePool());

const msw = new Msw();

function interceptWire(
  handle: (request: WireRequest) => Response | Promise<Response>,
) {
  const requests: WireRequest[] = [];
  const interception = msw.intercept(
    ...ORIGINS.map((origin) =>
      http.all(`${origin}/*`, async ({ request }) => {
        const body = await request.text();
        const wire: WireRequest = {
          url: request.url,
          authorization: request.headers.get('authorization'),
          apiKey: request.headers.get('x-api-key'),
          body:
            body && request.headers.get('content-type')?.includes('json')
              ? JSON.parse(body)
              : undefined,
        };
        requests.push(wire);
        return handle(wire);
      }),
    ),
  );
  return Object.assign(requests, {
    [Symbol.asyncDispose]: async () => {
      await interception.cleanup();
      await replaceGlobalPool();
    },
  });
}

/** Fails the request at the network level, as an unreachable host would. */
function unexpected(): Response {
  return Response.error();
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
  await using db = await testPostgres.database();
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    clock: createClock(),
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    onChange: (_owner, state) => changes.push(state),
  });
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
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
    hash('sha256', exchange?.code_verifier, 'base64url'),
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let exchanges = 0;
  await using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected();
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
  await using db = await testPostgres.database();
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    clock: createClock(),
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    onChange: (_owner, state) => changes.push(state),
  });
  const exchanging = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using _wire = interceptWire(async (request) => {
    if (request.url !== TOKEN_URL) return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let validRefreshToken = 'refresh-1';
  let refreshes = 0;
  await using requests = interceptWire(async (request) => {
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
    return unexpected();
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
  await using db = await testPostgres.database();
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    clock: createClock(),
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    onChange: (_owner, state) => changes.push(state),
  });
  await using _wire = interceptWire((request) => {
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
    return unexpected();
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

test('a revoked refresh token fails the request only after reporting the disconnect', async (t) => {
  await using db = await testPostgres.database();
  const pool = db.pool();
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    clock: createClock(),
    store: await PostgresAccountStore.create({ pool }),
    onChange: (_owner, state) => changes.push(state),
  });
  // Another session holds the sign-in table, so reading the state to report waits.
  const reader = await pool.connect();
  try {
    await using _wire = interceptWire(async (request) => {
      if (
        request.url === TOKEN_URL &&
        request.body?.grant_type === 'authorization_code'
      ) {
        return tokens('access-1', 'refresh-1', { expires_in: 30 });
      }
      if (request.url === TOKEN_URL) {
        await reader.query(
          'BEGIN; LOCK TABLE provider_account_sign_ins IN ACCESS EXCLUSIVE MODE',
        );
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return unexpected();
    });
    await signIn(accounts, 'owner-a');

    const failing = ask(accounts, 'owner-a').catch((error) => error);
    await waitFor(
      async () => {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_locks
           WHERE relation = 'provider_account_sign_ins'::regclass AND NOT granted`,
        );
        assert.equal(waiting.rowCount, 1);
      },
      { signal: t.signal },
    );
    const settledWhileReportWaits = await Promise.race([
      failing.then(() => true),
      sleep(1_000).then(() => false),
    ]);
    await reader.query('COMMIT');
    const failure = await failing;

    assert.equal(settledWhileReportWaits, false);
    assert.ok(failure instanceof ClaudeAuthError);
    assert.equal(failure.code, 'refresh-token-invalid');
    assert.deepStrictEqual(changes.at(-1), { status: 'unauthenticated' });
  } finally {
    reader.release();
  }
});

test('a failed refresh keeps the account and hides the token endpoint body', async () => {
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let refreshes = 0;
  await using _wire = interceptWire((request) => {
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
    return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let refreshes = 0;
  await using requests = interceptWire((request) => {
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
    return unexpected();
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

test('a request aborted while another request refreshes the token stops waiting for that refresh', async (t) => {
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let refreshes = 0;
  await using requests = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', { expires_in: 30 });
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      refreshing.resolve();
      await release.promise;
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
  });

  await signIn(accounts, 'owner-a');
  const refreshingRequest = ask(accounts, 'owner-a');
  try {
    await refreshing.promise;
    const controller = new AbortController();
    const waitingRequest = generateText({
      model: accounts.provider('owner-a')('claude-sonnet-4-6'),
      prompt: 'hello',
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    // Nothing outside the provider shows that a request waits for the
    // refresh, so the request gets time to reach the wait before the abort.
    await sleep(100);
    controller.abort();
    await untilAborted(
      assert.rejects(waitingRequest, { name: 'AbortError' }),
      t.signal,
    );
  } finally {
    release.resolve();
    await Promise.allSettled([refreshingRequest]);
  }

  assert.equal((await refreshingRequest).text, 'hi');
  assert.equal(refreshes, 1);
  assert.deepStrictEqual(
    requests
      .filter((request) => request.url === MESSAGES_URL)
      .map((request) => request.authorization),
    ['Bearer access-2'],
  );
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('a retry aborted while another retry refreshes a rejected token stops waiting for that refresh', async (t) => {
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const waitingAtApi = Promise.withResolvers<void>();
  const rejectWaiting = Promise.withResolvers<void>();
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let refreshes = 0;
  await using _wire = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1');
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      refreshing.resolve();
      await release.promise;
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) {
      if (request.authorization !== 'Bearer access-1') {
        return message('after refresh');
      }
      // The waiting request reaches the API before the other one, so its
      // retry starts while the other retry already refreshes.
      if (JSON.stringify(request.body).includes('waiting')) {
        waitingAtApi.resolve();
        await rejectWaiting.promise;
      }
      return Response.json({ type: 'error' }, { status: 401 });
    }
    return unexpected();
  });

  await signIn(accounts, 'owner-a');
  const controller = new AbortController();
  const waitingRequest = generateText({
    model: accounts.provider('owner-a')('claude-sonnet-4-6'),
    prompt: 'waiting',
    maxRetries: 0,
    abortSignal: controller.signal,
  });
  await waitingAtApi.promise;
  const refreshingRequest = ask(accounts, 'owner-a');
  try {
    await refreshing.promise;
    rejectWaiting.resolve();
    // Nothing outside the provider shows that the retry waits for the
    // refresh, so the retry gets time to reach the wait before the abort.
    await sleep(100);
    controller.abort();
    await untilAborted(
      assert.rejects(waitingRequest, { name: 'AbortError' }),
      t.signal,
    );
  } finally {
    rejectWaiting.resolve();
    release.resolve();
    await Promise.allSettled([refreshingRequest]);
  }

  assert.equal((await refreshingRequest).text, 'after refresh');
  assert.equal(refreshes, 1);
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('an access token still rejected after refresh fails the request but keeps the account', async () => {
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using _wire = interceptWire((request) => {
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
    return unexpected();
  });

  await signIn(accounts, 'owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);

  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'access-token-invalid');
  assert.equal((await accounts.state('owner-a')).status, 'connected');
});

test('a refresh finishing after a disconnect cannot reconnect the account', async () => {
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using _wire = interceptWire(async (request) => {
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
    return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    const url = new URL(request.url);
    if (url.origin + url.pathname !== 'https://api.anthropic.com/v1/models') {
      return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let profileAvailable = false;
  await using requests = interceptWire((request) => {
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
    return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      const owner = String(request.body?.code).replace('code-', '');
      return tokens(`access-${owner}`, `refresh-${owner}`);
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using _wire = interceptWire((request) => {
    if (request.url !== TOKEN_URL) return unexpected();
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
  await using db = await testPostgres.database();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let validRefreshToken = 'refresh-owner-b';
  let refreshes = 0;
  await using _wire = interceptWire(async (request) => {
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
    return unexpected();
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
  await using db = await testPostgres.database();
  const changes: ClaudeConnectionState[] = [];
  const accounts = createClaudeAccounts({
    clock: createClock(),
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    onChange: (_owner, state) => changes.push(state),
  });
  const exchanging = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using _wire = interceptWire(async (request) => {
    if (request.url !== TOKEN_URL) return unexpected();
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

test('an abandoned sign-in expires after ten minutes', async () => {
  await using db = await testPostgres.database();
  const clock = createClock();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock,
  });
  await using requests = interceptWire(unexpected);

  const pending = await accounts.connect('owner-a');
  assert.ok(pending.status === 'pending');
  await clock.tickAsync(10 * 60 * 1000 + 1);
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

test('a token refreshes when the clock reaches its expiry margin, and the new token lasts from that time', async () => {
  await using db = await testPostgres.database();
  const clock = createClock();
  const accounts = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock,
  });
  let issued = 0;
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      issued++;
      return tokens(`access-${issued}`, `refresh-${issued}`);
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
  });
  const untilMargin = 3600 * 1000 - 60_000;

  await signIn(accounts, 'owner-a');
  await ask(accounts, 'owner-a');
  await clock.tickAsync(untilMargin - 1);
  await ask(accounts, 'owner-a');
  await clock.tickAsync(1);
  await ask(accounts, 'owner-a');
  await clock.tickAsync(untilMargin - 1);
  await ask(accounts, 'owner-a');
  await clock.tickAsync(1);
  await ask(accounts, 'owner-a');

  assert.deepStrictEqual(
    requests
      .filter((request) => request.url === MESSAGES_URL)
      .map((request) => request.authorization),
    [
      'Bearer access-1',
      'Bearer access-1',
      'Bearer access-2',
      'Bearer access-2',
      'Bearer access-3',
    ],
  );
});

test('unreadable stored tokens read as a disconnected account', async () => {
  await using db = await testPostgres.database();
  const pool = db.pool();
  const store = await PostgresAccountStore.create({ pool });
  // A blob written by an older or broken writer of the database.
  await pool.query(
    `INSERT INTO provider_accounts (provider, owner, tokens, fence)
     VALUES ('claude', 'owner-a', '{"apiKey":"not-a-subscription"}', 1)`,
  );
  const accounts = createClaudeAccounts({ store, clock: createClock() });
  await using _wire = interceptWire(unexpected);

  const state = await accounts.state('owner-a');
  const failure = await ask(accounts, 'owner-a').catch((error) => error);

  assert.deepStrictEqual(state, { status: 'unauthenticated' });
  assert.ok(failure instanceof ClaudeAuthError);
  assert.equal(failure.code, 'not-connected');
});

test('a store that cannot save ends the sign-in with an error instead of throwing', async () => {
  await using db = await testPostgres.database();
  const pool = db.pool();
  const store = await PostgresAccountStore.create({ pool });
  // The database can refuse a write, for example a full disk or a revoked grant.
  await pool.query(`
    CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'The database refused the write.'; END $$;
    CREATE TRIGGER refuse_write BEFORE INSERT OR UPDATE ON provider_accounts
    FOR EACH ROW EXECUTE FUNCTION refuse_write();
  `);
  const accounts = createClaudeAccounts({ store, clock: createClock() });
  await using _wire = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    return unexpected();
  });

  const completed = await signIn(accounts, 'owner-a');

  assert.deepStrictEqual(completed, {
    status: 'error',
    message: 'The database refused the write.',
  });
  assert.deepStrictEqual(await accounts.state('owner-a'), {
    status: 'unauthenticated',
  });
});

test('two hosts refreshing one owner at once spend its refresh token once', async () => {
  await using db = await testPostgres.database();
  const hostA = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const hostB = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  let validRefreshToken = 'refresh-1';
  let refreshes = 0;
  await using requests = interceptWire(async (request) => {
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
      await sleep(20);
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
  });

  await signIn(hostA, 'owner-a');
  const results = await Promise.all([
    ask(hostA, 'owner-a'),
    ask(hostB, 'owner-a'),
  ]);

  assert.deepStrictEqual(
    {
      texts: results.map((result) => result.text),
      refreshes,
      authorizations: requests
        .filter((request) => request.url === MESSAGES_URL)
        .map((request) => request.authorization),
      states: [
        (await hostA.state('owner-a')).status,
        (await hostB.state('owner-a')).status,
      ],
    },
    {
      texts: ['hi', 'hi'],
      refreshes: 1,
      authorizations: ['Bearer access-2', 'Bearer access-2'],
      states: ['connected', 'connected'],
    },
  );
});

test('a disconnect on one host wins over a refresh in flight on another', async () => {
  await using db = await testPostgres.database();
  const hostA = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const hostB = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using _wire = interceptWire(async (request) => {
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
    return unexpected();
  });

  await signIn(hostA, 'owner-a');
  const asking = ask(hostA, 'owner-a').catch((error) => error);
  await refreshing.promise;
  await hostB.disconnect('owner-a');
  release.resolve();
  const failure = await asking;

  assert.ok(failure instanceof ClaudeAuthError);
  assert.deepStrictEqual(
    {
      code: failure.code,
      hostA: await hostA.state('owner-a'),
      hostB: await hostB.state('owner-a'),
    },
    {
      code: 'not-connected',
      hostA: { status: 'unauthenticated' },
      hostB: { status: 'unauthenticated' },
    },
  );
});

test('a sign-in started on one host completes on another', async () => {
  await using db = await testPostgres.database();
  const hostA = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  const hostB = createClaudeAccounts({
    store: await PostgresAccountStore.create({ pool: db.pool() }),
    clock: createClock(),
  });
  await using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    if (request.url === MESSAGES_URL) return message('hi');
    return unexpected();
  });

  const pending = await hostA.connect('owner-a');
  assert.ok(pending.status === 'pending');
  const seenOnB = await hostB.state('owner-a');
  const connected = await hostB.complete(
    'owner-a',
    `pasted-code#${new URL(pending.authorizationUrl).searchParams.get('state')}`,
  );
  await ask(hostA, 'owner-a');

  assert.deepStrictEqual(
    {
      seenOnB,
      connected,
      verifierMatches:
        hash(
          'sha256',
          requests.find((request) => request.url === TOKEN_URL)?.body
            ?.code_verifier,
          'base64url',
        ) ===
        new URL(pending.authorizationUrl).searchParams.get('code_challenge'),
      authorization: requests.find((request) => request.url === MESSAGES_URL)
        ?.authorization,
    },
    {
      seenOnB: pending,
      connected: { status: 'connected', user: { email: 'ada@example.com' } },
      verifierMatches: true,
      authorization: 'Bearer access-1',
    },
  );
});
