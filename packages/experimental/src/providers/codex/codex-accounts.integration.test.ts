import { MemoryStore } from '@opencoredev/loginwithchatgpt-core';
import { generateText } from 'ai';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CodexAuthError,
  type CodexConnectionState,
  createCodexAccounts,
} from '@deepagents/experimental/providers/codex';

const USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const POLL_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

const ORIGINS = ['https://auth.openai.com', 'https://chatgpt.com'];

interface WireRequest {
  url: string;
  headers: Headers;
  signal: AbortSignal;
  body: Record<string, any> | undefined;
}

function interceptWire(
  handle: (request: WireRequest) => Response | Promise<Response>,
) {
  const requests: WireRequest[] = [];
  const server = setupServer(
    ...ORIGINS.map((origin) =>
      http.all(`${origin}/*`, async ({ request }) => {
        const url = new URL(request.url);
        const body = await request.text();
        const wire: WireRequest = {
          url: url.origin + url.pathname,
          headers: request.headers,
          signal: request.signal,
          body: !body
            ? undefined
            : request.headers.get('content-type')?.includes('json')
              ? JSON.parse(body)
              : Object.fromEntries(new URLSearchParams(body)),
        };
        requests.push(wire);
        return handle(wire);
      }),
    ),
  );
  server.listen({ onUnhandledFrame: 'error' });
  return Object.assign(requests, {
    [Symbol.dispose]: () => server.close(),
  });
}

/** Settles once the client gives up on the request. */
function abortOf(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

/** Fails the request at the network level, as an unreachable host would. */
function unexpected(): Response {
  return Response.error();
}

function idToken(accountId: string) {
  const claims = {
    email: 'ada@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'plus',
    },
  };
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function tokenBody(
  accessToken: string,
  refreshToken: string,
  expiresIn = 3600,
) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    id_token: idToken('account-1'),
    expires_in: expiresIn,
  };
}

function tokens(accessToken: string, refreshToken: string, expiresIn = 3600) {
  return Response.json(tokenBody(accessToken, refreshToken, expiresIn));
}

/** Answers the device sign-in endpoints; the token exchange is per test. */
function deviceSignIn(request: WireRequest) {
  if (request.url === USERCODE_URL) {
    return Response.json({
      device_auth_id: 'device-1',
      user_code: 'ABCD-1234',
      interval: 0.01,
    });
  }
  if (request.url === POLL_URL) {
    return Response.json({
      authorization_code: 'authorization-1',
      code_challenge: 'challenge-1',
      code_verifier: 'verifier-1',
    });
  }
  return undefined;
}

function reply(text: string) {
  const events = [
    {
      type: 'response.created',
      response: {
        id: 'response-1',
        created_at: 1_700_000_000,
        model: 'gpt-5.5',
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'message-1' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'message-1',
      output_index: 0,
      delta: text,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'message-1' },
    },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 4 } },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function connectedAccounts(changes: CodexConnectionState[] = []) {
  const settled = new Map<string, PromiseWithResolvers<void>>();
  const accounts = createCodexAccounts({
    store: new MemoryStore(),
    onChange: (owner, state) => {
      changes.push(state);
      if (state.status === 'connected') settled.get(owner)?.resolve();
      if (state.status === 'error') {
        settled.get(owner)?.reject(new Error(state.message));
      }
    },
  });
  return {
    accounts,
    /** Resolves once device sign-in for this owner reports `connected`. */
    signIn: async (owner: string) => {
      const signedIn = Promise.withResolvers<void>();
      settled.set(owner, signedIn);
      await Promise.all([accounts.connect(owner), signedIn.promise]);
    },
  };
}

function ask(accounts: ReturnType<typeof createCodexAccounts>, owner: string) {
  return generateText({
    model: accounts.provider(owner)('gpt-5.5'),
    prompt: 'hello',
    maxRetries: 0,
  });
}

test('device sign-in connects the account and authenticates its models', async () => {
  const changes: CodexConnectionState[] = [];
  const { accounts, signIn } = connectedAccounts(changes);
  let polls = 0;
  using requests = interceptWire((request) => {
    if (request.url === POLL_URL && ++polls === 1) {
      return new Response(null, { status: 403 });
    }
    const signInResponse = deviceSignIn(request);
    if (signInResponse) return signInResponse;
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    if (request.url === RESPONSES_URL) return reply('hi');
    return unexpected();
  });

  try {
    await signIn('owner-a');
    const state = await accounts.state('owner-a');
    const result = await ask(accounts, 'owner-a');

    assert.ok(changes[0].status === 'pending');
    assert.equal(changes[0].userCode, 'ABCD-1234');
    assert.equal(
      changes[0].verificationUrl,
      'https://auth.openai.com/codex/device',
    );
    assert.ok(state.status === 'connected');
    assert.deepStrictEqual(
      {
        accountId: state.user?.accountId,
        email: state.user?.email,
        plan: state.user?.plan,
      },
      { accountId: 'account-1', email: 'ada@example.com', plan: 'plus' },
    );
    const exchange = requests.find((request) => request.url === TOKEN_URL);
    assert.equal(exchange?.body?.grant_type, 'authorization_code');
    assert.equal(exchange?.body?.code, 'authorization-1');
    assert.equal(exchange?.body?.code_verifier, 'verifier-1');
    assert.equal(result.text, 'hi');
    const modelRequest = requests.find(
      (request) => request.url === RESPONSES_URL,
    );
    assert.equal(modelRequest?.headers.get('authorization'), 'Bearer access-1');
    assert.equal(modelRequest?.headers.get('chatgpt-account-id'), 'account-1');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('an authorization arriving after the owner cancelled the sign-in saves nothing', async () => {
  const polling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<CodexConnectionState>();
  let released = false;
  const accounts = createCodexAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => {
      if (released) reported.resolve(state);
    },
  });
  // Cancelling aborts the poll in flight, so the authorization the server sends
  // afterwards never reaches the sign-in.
  using _wire = interceptWire(async (request) => {
    if (request.url === POLL_URL) {
      polling.resolve();
      await release.promise;
    }
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await accounts.connect('owner-a');
    await polling.promise;
    accounts.cancel('owner-a');
    released = true;
    release.resolve();
    const report = await reported.promise;
    const failure = await ask(accounts, 'owner-a').catch((error) => error);

    assert.deepStrictEqual(report, { status: 'unauthenticated' });
    assert.deepStrictEqual(await accounts.state('owner-a'), {
      status: 'unauthenticated',
    });
    assert.ok(failure instanceof CodexAuthError);
    assert.equal(failure.code, 'not-connected');
  } finally {
    accounts.cancel('owner-a');
  }
});

test(
  'cancelling a sign-in aborts its device poll in flight and polls no more',
  { timeout: 5_000 },
  async () => {
    const polling = Promise.withResolvers<AbortSignal>();
    const reported = Promise.withResolvers<CodexConnectionState>();
    const accounts = createCodexAccounts({
      store: new MemoryStore(),
      onChange: (_owner, state) => {
        if (state.status === 'unauthenticated') reported.resolve(state);
      },
    });
    using requests = interceptWire((request) => {
      if (request.url === POLL_URL) {
        polling.resolve(request.signal);
        return new Promise<never>(() => {});
      }
      return deviceSignIn(request) ?? unexpected();
    });

    try {
      await accounts.connect('owner-a');
      const poll = await polling.promise;
      accounts.cancel('owner-a');
      await abortOf(poll);
      const report = await reported.promise;

      assert.deepStrictEqual(report, { status: 'unauthenticated' });
      assert.equal(requests.filter(({ url }) => url === POLL_URL).length, 1);
    } finally {
      accounts.cancel('owner-a');
    }
  },
);

test(
  'disconnecting during sign-in aborts the device poll in flight',
  { timeout: 5_000 },
  async () => {
    const polling = Promise.withResolvers<AbortSignal>();
    const accounts = createCodexAccounts({ store: new MemoryStore() });
    using _wire = interceptWire((request) => {
      if (request.url === POLL_URL) {
        polling.resolve(request.signal);
        return new Promise<never>(() => {});
      }
      return deviceSignIn(request) ?? unexpected();
    });

    try {
      await accounts.connect('owner-a');
      const poll = await polling.promise;
      const disconnected = await accounts.disconnect('owner-a');
      await abortOf(poll);

      assert.deepStrictEqual(disconnected, { status: 'unauthenticated' });
    } finally {
      accounts.cancel('owner-a');
    }
  },
);

test(
  'cancelling a sign-in aborts its code exchange in flight and saves nothing',
  { timeout: 5_000 },
  async () => {
    const exchanging = Promise.withResolvers<AbortSignal>();
    const reported = Promise.withResolvers<CodexConnectionState>();
    const accounts = createCodexAccounts({
      store: new MemoryStore(),
      onChange: (_owner, state) => {
        if (state.status === 'unauthenticated') reported.resolve(state);
      },
    });
    using _wire = interceptWire((request) => {
      if (request.url === TOKEN_URL) {
        exchanging.resolve(request.signal);
        return new Promise<never>(() => {});
      }
      return deviceSignIn(request) ?? unexpected();
    });

    try {
      await accounts.connect('owner-a');
      const exchange = await exchanging.promise;
      accounts.cancel('owner-a');
      await abortOf(exchange);

      assert.deepStrictEqual(await reported.promise, {
        status: 'unauthenticated',
      });
      assert.deepStrictEqual(await accounts.state('owner-a'), {
        status: 'unauthenticated',
      });
    } finally {
      accounts.cancel('owner-a');
    }
  },
);

test('a failed device code request is reported and sign-in can start again', async () => {
  const accounts = createCodexAccounts({ store: new MemoryStore() });
  let codeRequests = 0;
  using _wire = interceptWire((request) => {
    if (request.url === USERCODE_URL && ++codeRequests === 1) {
      return new Response('secret-device-detail', { status: 503 });
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    const failed = await accounts.connect('owner-a');
    const retried = await accounts.connect('owner-a');

    assert.equal(failed.status, 'error');
    assert.doesNotMatch(JSON.stringify(failed), /secret-device-detail/);
    assert.equal(retried.status, 'pending');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a revoked refresh token disconnects the account and reports it', async () => {
  const changes: CodexConnectionState[] = [];
  const { accounts, signIn } = connectedAccounts(changes);
  using _wire = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', 30);
    }
    if (request.url === TOKEN_URL) {
      return Response.json(
        {
          error: 'refresh_token_reused',
          error_description: 'secret-refresh-detail',
        },
        { status: 401 },
      );
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const failure = await ask(accounts, 'owner-a').catch((error) => error);

    assert.ok(failure instanceof CodexAuthError);
    assert.equal(failure.code, 'refresh-token-invalid');
    assert.doesNotMatch(failure.message, /secret-refresh-detail/);
    assert.deepStrictEqual(await accounts.state('owner-a'), {
      status: 'unauthenticated',
    });
    assert.deepStrictEqual(changes.at(-1), { status: 'unauthenticated' });
  } finally {
    accounts.cancel('owner-a');
  }
});

test('concurrent requests on an expiring token refresh once and keep the account connected', async () => {
  const { accounts, signIn } = connectedAccounts();
  let validRefreshToken = 'refresh-1';
  let refreshes = 0;
  using requests = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', 30);
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      // OpenAI rotates refresh tokens: a second use of the old one fails.
      if (request.body?.refresh_token !== validRefreshToken) {
        return Response.json(
          { error: 'refresh_token_reused' },
          { status: 401 },
        );
      }
      validRefreshToken = 'refresh-2';
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tokens('access-2', 'refresh-2');
    }
    if (request.url === RESPONSES_URL) return reply('hi');
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
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
        .filter((request) => request.url === RESPONSES_URL)
        .map((request) => request.headers.get('authorization')),
      ['Bearer access-2', 'Bearer access-2', 'Bearer access-2'],
    );
    assert.equal((await accounts.state('owner-a')).status, 'connected');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a failed refresh keeps the account and hides the token endpoint body', async () => {
  const { accounts, signIn } = connectedAccounts();
  let refreshes = 0;
  using _wire = interceptWire((request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', 30);
    }
    if (request.url === TOKEN_URL) {
      refreshes++;
      return refreshes === 1
        ? new Response('secret-outage-detail', { status: 503 })
        : tokens('access-2', 'refresh-2');
    }
    if (request.url === RESPONSES_URL) return reply('recovered');
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const failure = await ask(accounts, 'owner-a').catch((error) => error);
    const retried = await ask(accounts, 'owner-a');

    assert.ok(failure instanceof CodexAuthError);
    assert.equal(failure.code, 'refresh-failed');
    assert.doesNotMatch(failure.message, /secret-outage-detail/);
    assert.equal(retried.text, 'recovered');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a rejected access token is refreshed once and the request retried', async () => {
  const { accounts, signIn } = connectedAccounts();
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
    if (request.url === RESPONSES_URL) {
      return request.headers.get('authorization') === 'Bearer access-1'
        ? Response.json({ detail: 'Unauthorized' }, { status: 401 })
        : reply('after refresh');
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const result = await ask(accounts, 'owner-a');

    assert.equal(result.text, 'after refresh');
    assert.equal(refreshes, 1);
    assert.deepStrictEqual(
      requests
        .filter((request) => request.url === RESPONSES_URL)
        .map((request) => request.headers.get('authorization')),
      ['Bearer access-1', 'Bearer access-2'],
    );
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a refresh finishing after a disconnect cannot reconnect the account', async () => {
  const { accounts, signIn } = connectedAccounts();
  const refreshing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  using _wire = interceptWire(async (request) => {
    if (
      request.url === TOKEN_URL &&
      request.body?.grant_type === 'authorization_code'
    ) {
      return tokens('access-1', 'refresh-1', 30);
    }
    if (request.url === TOKEN_URL) {
      refreshing.resolve();
      await release.promise;
      return tokens('access-2', 'refresh-2');
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const asking = ask(accounts, 'owner-a').catch((error) => error);
    await refreshing.promise;
    await accounts.disconnect('owner-a');
    release.resolve();
    const failure = await asking;

    assert.ok(failure instanceof CodexAuthError);
    assert.equal(failure.code, 'not-connected');
    assert.deepStrictEqual(await accounts.state('owner-a'), {
      status: 'unauthenticated',
    });
  } finally {
    accounts.cancel('owner-a');
  }
});

test('models are listed for the connected account', async () => {
  const { accounts, signIn } = connectedAccounts();
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) return tokens('access-1', 'refresh-1');
    if (request.url === MODELS_URL) {
      return Response.json({
        models: [{ slug: 'gpt-5.5' }, { slug: 'gpt-5.5-mini' }],
      });
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const models = await accounts.listModels('owner-a');

    assert.deepStrictEqual(models, ['gpt-5.5', 'gpt-5.5-mini']);
    const listing = requests.find((request) => request.url === MODELS_URL);
    assert.equal(listing?.headers.get('authorization'), 'Bearer access-1');
    assert.equal(listing?.headers.get('chatgpt-account-id'), 'account-1');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a sign-in rejected at authorization is reported without the response body and can start again', async () => {
  const changes: CodexConnectionState[] = [];
  const failed = Promise.withResolvers<void>();
  const accounts = createCodexAccounts({
    store: new MemoryStore(),
    onChange: (_owner, state) => {
      changes.push(state);
      if (state.status === 'error') failed.resolve();
    },
  });
  using _wire = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      return Response.json(
        { error: 'invalid_grant', error_description: 'secret-exchange-detail' },
        { status: 400 },
      );
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await accounts.connect('owner-a');
    await failed.promise;
    const restarted = await accounts.connect('owner-a');

    assert.equal(changes.at(-2)?.status, 'error');
    assert.doesNotMatch(JSON.stringify(changes), /secret-exchange-detail/);
    assert.equal(restarted.status, 'pending');
  } finally {
    accounts.cancel('owner-a');
  }
});

test('connecting again while a sign-in is pending keeps the same code', async () => {
  const accounts = createCodexAccounts({ store: new MemoryStore() });
  using requests = interceptWire((request) => {
    if (request.url === POLL_URL) return new Response(null, { status: 403 });
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    const first = await accounts.connect('owner-a');
    const second = await accounts.connect('owner-a');

    assert.deepStrictEqual(second, first);
    assert.equal(
      requests.filter((request) => request.url === USERCODE_URL).length,
      1,
    );
  } finally {
    accounts.cancel('owner-a');
  }
});

test('a connection without an account identifier fails model requests before sending them', async () => {
  const { accounts, signIn } = connectedAccounts();
  using requests = interceptWire((request) => {
    if (request.url === TOKEN_URL) {
      return Response.json({
        access_token: 'opaque-access',
        refresh_token: 'refresh-1',
        id_token: `header.${Buffer.from(JSON.stringify({ email: 'ada@example.com' })).toString('base64url')}.signature`,
        expires_in: 3600,
      });
    }
    return deviceSignIn(request) ?? unexpected();
  });

  try {
    await signIn('owner-a');
    const failure = await ask(accounts, 'owner-a').catch((error) => error);

    assert.ok(failure instanceof CodexAuthError);
    assert.equal(failure.code, 'missing-account-id');
    assert.ok(requests.every((request) => request.url !== RESPONSES_URL));
  } finally {
    accounts.cancel('owner-a');
  }
});
