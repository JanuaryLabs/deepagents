import { NoSuchModelError } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import {
  createProviderRegistry,
  defaultSettingsMiddleware,
  generateText,
  isStepCount,
  streamText,
  tool,
  wrapProvider,
} from 'ai';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempDisposable,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';
import { z } from 'zod';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import { codex, createCodex } from '@deepagents/experimental/providers/codex';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

function accessToken(expiresAt = Date.now() + 3_600_000) {
  return `header.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString('base64url')}.signature`;
}

function login(accountId = 'account-a', expiresAt?: number) {
  return {
    auth_mode: 'chatgpt',
    last_refresh: 'original',
    extra: { preserve: true },
    tokens: {
      access_token: accessToken(expiresAt),
      refresh_token: `refresh-${accountId}`,
      id_token: 'original-id-token',
      account_id: accountId,
    },
  };
}

async function localHome(t: TestContext) {
  const directory = await mkdtempDisposable(
    join(tmpdir(), 'chatgpt-provider-'),
  );
  t.after(() => directory.remove());
  t.mock.property(process, 'env', {
    ...process.env,
    CODEX_HOME: directory.path,
    OPENAI_API_KEY: 'must-not-be-used',
  });
  await writeFile(join(directory.path, 'auth.json'), JSON.stringify(login()));
  return directory.path;
}

function response(text: string, toolCall = false) {
  const item = toolCall
    ? {
        type: 'function_call',
        id: 'item-call',
        call_id: 'call-1',
        name: 'read_marker',
        arguments: '',
      }
    : { type: 'message', id: 'message-1' };
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
      item: { type: 'reasoning', id: 'reasoning-1' },
    },
    {
      type: 'response.reasoning_summary_part.added',
      item_id: 'reasoning-1',
      summary_index: 0,
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'reasoning-1',
      summary_index: 0,
      delta: 'Checking the marker.',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'reasoning-1',
        encrypted_content: 'encrypted-reasoning',
      },
    },
    { type: 'response.output_item.added', output_index: 1, item },
    ...(toolCall
      ? [
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'item-call',
            output_index: 1,
            delta: '{}',
          },
        ]
      : [
          {
            type: 'response.output_text.delta',
            item_id: 'message-1',
            output_index: 1,
            delta: text,
          },
        ]),
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        ...item,
        ...(toolCall ? { arguments: '{}', status: 'completed' } : {}),
      },
    },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

test('AI SDK registry and middleware share the callable provider contract', async (t) => {
  await localHome(t);
  const requests: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      assert.equal(body.model, 'account-specific-model');
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      return response('blue');
    },
  );

  const provider = createCodex();
  const registry = createProviderRegistry({
    codex: wrapProvider({
      provider,
      languageModelMiddleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openai: {
              store: true,
              // The SDK cannot infer capabilities from this custom model ID.
              forceReasoning: true,
              reasoningEffort: 'low',
            },
          },
        },
      }),
    }),
  });

  for (const model of [
    provider('account-specific-model'),
    codex.languageModel('account-specific-model'),
    registry.languageModel('codex:account-specific-model'),
  ]) {
    assert.equal(model.provider, 'codex.responses');
    const result = await generateText({ model, prompt: 'Read the marker.' });
    assert.equal(result.text, 'blue');
  }
  assert.equal(requests.length, 3);
  assert.partialDeepStrictEqual(requests[2].reasoning, { effort: 'low' });
  assert.equal(provider.specificationVersion, 'v4');
  for (const getModel of [
    () => registry.embeddingModel('codex:unsupported'),
    () => registry.imageModel('codex:unsupported'),
    () => registry.transcriptionModel('codex:unsupported'),
    () => registry.speechModel('codex:unsupported'),
    () => registry.rerankingModel('codex:unsupported'),
  ]) {
    assert.throws(getModel, (error) => NoSuchModelError.isInstance(error));
  }
  assert.equal(provider.files, undefined);
  assert.equal(provider.skills, undefined);
  assert.equal(requests.length, 3);
});

test('the public model keeps host tool execution and stateless follow-up history', async (t) => {
  await localHome(t);
  const requests: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(input.toString()).origin, 'https://chatgpt.com');
      const headers = new Headers(init?.headers);
      const authorization = headers.get('authorization');
      assert.ok(authorization);
      assert.match(authorization, /^Bearer header\./);
      assert.equal(headers.get('chatgpt-account-id'), 'account-a');
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.ok(body.include.includes('reasoning.encrypted_content'));
      assert.equal(body.max_output_tokens, undefined);
      return response(
        requests.length === 3 ? 'The previous marker was blue.' : 'blue',
        requests.length === 1,
      );
    },
  );
  let executions = 0;
  const model = codex('gpt-5.5');
  assert.equal(model.provider, 'codex.responses');
  const result = streamText({
    model,
    prompt: 'Read the marker.',
    tools: {
      read_marker: tool({
        inputSchema: z.object({}),
        execute: async () => {
          executions++;
          return 'blue';
        },
      }),
    },
    stopWhen: isStepCount(3),
    maxRetries: 0,
  });
  assert.equal(await result.text, 'blue');
  assert.equal(executions, 1);
  assert.equal((await result.steps).length, 2);

  const followup = await generateText({
    model,
    messages: [
      { role: 'user', content: 'Read the marker.' },
      ...(await result.responseMessages),
      { role: 'user', content: 'What was the marker?' },
    ],
    maxRetries: 0,
  });
  assert.equal(followup.text, 'The previous marker was blue.');
  assert.equal(followup.usage.inputTokens, 12);
  assert.equal(followup.reasoningText, 'Checking the marker.');
  assert.equal(followup.response.id, 'response-1');
  const input = requests[2].input as Array<Record<string, unknown>>;
  assert.ok(
    input.some(
      (item) => item.type === 'function_call' && item.call_id === 'call-1',
    ),
  );
  assert.ok(
    input.some(
      (item) => item.type === 'function_call_output' && item.output === 'blue',
    ),
  );
  assert.ok(
    input.some(
      (item) =>
        item.type === 'reasoning' &&
        item.encrypted_content === 'encrypted-reasoning',
    ),
  );
  assert.ok(input.every((item) => item.type !== 'item_reference'));
});

test('generateText uses streaming transport, including host tool calls', async (t) => {
  await localHome(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    response('blue', ++requests === 1),
  );
  let executions = 0;
  const result = await generateText({
    model: createCodex()('gpt-5.5'),
    prompt: 'Read the marker.',
    tools: {
      read_marker: tool({
        inputSchema: z.object({}),
        execute: async () => {
          executions++;
          return 'blue';
        },
      }),
    },
    stopWhen: isStepCount(3),
    maxRetries: 0,
  });
  assert.deepEqual(
    { text: result.text, executions, steps: result.steps.length },
    { text: 'blue', executions: 1, steps: 2 },
  );
});

test('authentication is lazy, notices account changes, and never uses an API key', async (t) => {
  const home = await localHome(t);
  await writeFile(
    join(home, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'do-not-use' }),
  );
  const model = codex('gpt-5.5');
  const accounts: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      const account = new Headers(init?.headers).get('chatgpt-account-id');
      assert.ok(account);
      accounts.push(account);
      return response('ok');
    },
  );
  await assert.rejects(
    generateText({ model, prompt: 'hello', maxRetries: 0 }),
    /codex login/i,
  );
  assert.deepEqual(accounts, []);
  for (const account of ['account-a', 'account-b']) {
    await writeFile(join(home, 'auth.json'), JSON.stringify(login(account)));
    assert.equal(
      (await generateText({ model, prompt: 'hello', maxRetries: 0 })).text,
      'ok',
    );
  }
  assert.deepEqual(accounts, ['account-a', 'account-b']);
});

for (const rotate of [true, false]) {
  test(`concurrent providers refresh once and preserve native fields (rotate=${rotate})`, async (t) => {
    const home = await localHome(t);
    await writeFile(
      join(home, 'auth.json'),
      JSON.stringify(login('account-a', rotate ? 0 : Date.now() + 30_000)),
    );
    let refreshes = 0;
    const freshAccessToken = accessToken(Date.now() + 7_200_000);
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(input.toString()).hostname === 'auth.openai.com') {
          refreshes++;
          assert.equal(
            JSON.parse(String(init?.body)).refresh_token,
            'refresh-account-a',
          );
          return Response.json({
            access_token: freshAccessToken,
            refresh_token: rotate ? 'rotated-refresh' : undefined,
            expires_in: 7200,
          });
        }
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          `Bearer ${freshAccessToken}`,
        );
        return response('ok');
      },
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        generateText({
          model: createCodex()('gpt-5.5'),
          prompt: 'hello',
          maxRetries: 0,
        }),
      ),
    );
    const saved = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
    assert.equal(refreshes, 1);
    assert.equal(
      saved.tokens.refresh_token,
      rotate ? 'rotated-refresh' : 'refresh-account-a',
    );
    assert.equal(saved.tokens.id_token, 'original-id-token');
    assert.equal(saved.tokens.account_id, 'account-a');
    assert.deepEqual(saved.extra, { preserve: true });
    assert.equal((await stat(join(home, 'auth.json'))).mode & 0o777, 0o600);
  });
}

test('a refresh cannot replace a newer native login', async (t) => {
  const home = await localHome(t);
  await writeFile(
    join(home, 'auth.json'),
    JSON.stringify(login('account-a', 0)),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(input.toString()).hostname === 'auth.openai.com') {
        await writeFile(
          join(home, 'auth.json'),
          JSON.stringify(login('account-b')),
        );
        return Response.json({
          access_token: accessToken(),
          refresh_token: 'stale-refresh',
          expires_in: 3600,
        });
      }
      assert.equal(
        new Headers(init?.headers).get('chatgpt-account-id'),
        'account-b',
      );
      return response('ok');
    },
  );
  await generateText({
    model: createCodex()('gpt-5.5'),
    prompt: 'hello',
    maxRetries: 0,
  });
  assert.equal(
    JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens
      .refresh_token,
    'refresh-account-b',
  );
});

test('keyring mode uses the Codex service and canonical-home account', async (t) => {
  const home = await localHome(t);
  await writeFile(
    join(home, 'config.toml'),
    'cli_auth_credentials_store = "keyring"\n',
  );
  const account = `cli|${createHash('sha256')
    .update(await realpath(home))
    .digest('hex')
    .slice(0, 16)}`;
  t.mock.module('@napi-rs/keyring', {
    namedExports: {
      AsyncEntry: class {
        constructor(service: string, username: string) {
          assert.equal(service, 'Codex Auth');
          assert.equal(username, account);
        }
        async getPassword() {
          return JSON.stringify(login('keyring-account'));
        }
      },
    },
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      assert.equal(
        new Headers(init?.headers).get('chatgpt-account-id'),
        'keyring-account',
      );
      return response('ok');
    },
  );
  await generateText({
    model: createCodex()('gpt-5.5'),
    prompt: 'hello',
    maxRetries: 0,
  });
});

test('ephemeral mode does not reuse an older auth.json', async (t) => {
  const home = await localHome(t);
  await writeFile(
    join(home, 'config.toml'),
    'cli_auth_credentials_store = "ephemeral"\n',
  );
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not call');
  });
  await assert.rejects(
    generateText({
      model: codex('gpt-5.5'),
      prompt: 'hello',
      maxRetries: 0,
    }),
    /ephemeral/i,
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test('cancellation reaches the model request', async (t) => {
  await localHome(t);
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error('abort signal was not forwarded');
    },
  );
  await assert.rejects(
    generateText({
      model: createCodex()('gpt-5.5'),
      prompt: 'hello',
      maxRetries: 0,
      abortSignal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('Zukhruf executes a host tool and persists history across queued turns', async (t) => {
  await localHome(t);
  const requests: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return response('blue', requests.length === 1);
    },
  );
  let executions = 0;
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      name: 'ChatGPTTest',
      model: codex('gpt-5.5'),
      instructions: [],
      sandbox: defineSandbox(() =>
        createVirtualSandbox({ fs: new InMemoryFs() }),
      ),
      tools: {
        read_marker: tool({
          inputSchema: z.object({}),
          execute: async () => {
            executions++;
            return 'blue';
          },
        }),
      },
    }),
  );
  const stack = defineStack(async (resources) => {
    const database = resources.use(new PGlite());
    const boss = resources.adopt(
      new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
      (boss) => boss.stop({ graceful: false }),
    );
    boss.on('error', (error) => {
      throw error;
    });
    await boss.start();
    const queue = new PgBossTurnQueue(boss, {
      pollingIntervalSeconds: 0.5,
      schema: 'pgboss',
    });
    await queue.initialize();
    const streamStore = new SqliteStreamStore(
      resources.use(new DatabaseSync(':memory:')),
    );
    return {
      store: new SqliteContextStore(
        resources.use(new DatabaseSync(':memory:')),
      ),
      streams: new StreamManager({
        store: streamStore,
        changeSource: new PollingChangeSource({ reads: streamStore }),
      }),
      queue,
      mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
    };
  });
  await using runtime = await runtimeSetup.initialize(stack);
  await using worker = await runtime.work();
  const conversation = { chatId: 'provider-test', userId: 'user' };
  for (const text of ['Read the marker.', 'What was the marker?']) {
    const turn = await runtime.enqueue(conversation, {
      message: {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text }],
      },
      trigger: 'submit-message',
    });
    let answer = '';
    for await (const chunk of turn.stream) {
      if (chunk.type === 'error') assert.fail(chunk.errorText);
      if (chunk.type === 'text-delta') answer += chunk.delta;
    }
    assert.equal(answer, 'blue');
    assert.equal(
      (await runtime.observe(conversation).status(turn.id))?.status,
      'completed',
    );
  }
  assert.equal(executions, 1);
  assert.equal(requests.length, 3);
  const history = requests[2].input as Array<Record<string, unknown>>;
  assert.ok(
    history.some(
      (item) => item.type === 'function_call_output' && item.output === 'blue',
    ),
  );
  assert.ok(
    history.some(
      (item) =>
        item.type === 'reasoning' &&
        item.encrypted_content === 'encrypted-reasoning',
    ),
  );
  assert.equal((await runtime.listHistory('user')).length, 1);
});
