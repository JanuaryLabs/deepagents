import { NoSuchModelError } from '@ai-sdk/provider';
import {
  createProviderRegistry,
  generateText,
  isStepCount,
  streamText,
  tool,
} from 'ai';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempDisposable, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { z } from 'zod';

import {
  claude,
  createClaude,
} from '@deepagents/experimental/providers/claude';

function login(accessToken = 'access-a', expiresAt = Date.now() + 3_600_000) {
  return {
    extra: { preserve: true },
    claudeAiOauth: {
      accessToken,
      refreshToken: 'refresh-a',
      expiresAt,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  };
}

async function localHome(t: TestContext, platform: NodeJS.Platform = 'linux') {
  const directory = await mkdtempDisposable(join(tmpdir(), 'claude-provider-'));
  t.after(() => directory.remove());
  t.mock.property(process, 'platform', platform);
  t.mock.property(process, 'env', {
    ...process.env,
    CLAUDE_CONFIG_DIR: directory.path,
    ANTHROPIC_API_KEY: 'must-not-be-used',
    ANTHROPIC_AUTH_TOKEN: 'must-not-be-used',
    ANTHROPIC_BASE_URL: 'https://must-not-receive-credentials.invalid',
  });
  await writeFile(
    join(directory.path, '.credentials.json'),
    JSON.stringify(login()),
  );
  return directory.path;
}

function response(text: string, stream = false, toolCall = false) {
  const block = toolCall
    ? {
        type: 'tool_use',
        id: 'call-1',
        name: 'ReadMarker',
        input: { name: 'mcp_untouched' },
      }
    : { type: 'text', text };
  const message = {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [block],
    stop_reason: toolCall ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    },
  };
  if (!stream) return Response.json(message);
  const events = [
    {
      type: 'message_start',
      message: { ...message, content: [], stop_reason: null },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: toolCall
        ? { ...block, input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: toolCall
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input),
          }
        : { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

for (const streaming of [true, false]) {
  test(`native Anthropic ${streaming ? 'streaming' : 'generation'} preserves host tools, caching and follow-up history`, async (t) => {
    await localHome(t);
    const requests: {
      cache_control: unknown;
      system: { text: string }[];
      tools: { name: string }[];
      messages: { content: { name?: string; type: string }[] }[];
    }[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), 'https://api.anthropic.com/v1/messages');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), 'Bearer access-a');
        assert.equal(headers.get('x-api-key'), null);
        assert.match(headers.get('anthropic-beta') ?? '', /oauth-2025-04-20/);
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        return response(
          requests.length === 3 ? 'The marker was blue.' : 'blue',
          body.stream,
          requests.length === 1,
        );
      },
    );
    let executions = 0;
    const registry = createProviderRegistry({ claude });
    const options = {
      model: registry.languageModel('claude:claude-sonnet-4-6'),
      system: 'Keep the caller instructions.',
      prompt: 'Read the marker.',
      tools: {
        ReadMarker: tool({
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            assert.equal(name, 'mcp_untouched');
            executions++;
            return 'blue';
          },
        }),
      },
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
      },
      stopWhen: isStepCount(3),
      maxRetries: 0,
    };
    const result = streaming
      ? streamText(options)
      : await generateText(options);
    assert.equal(await result.text, 'blue');
    assert.equal(executions, 1);
    assert.equal((await result.steps).length, 2);
    assert.deepEqual(requests[0].cache_control, {
      type: 'ephemeral',
      ttl: '1h',
    });
    assert.deepEqual(
      requests[0].system.map((part: { text: string }) => part.text),
      [
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        'Keep the caller instructions.',
      ],
    );
    assert.equal(requests[0].tools[0].name, 'ReadMarker');
    assert.equal(requests[1].messages[1].content[0].name, 'ReadMarker');
    assert.equal(requests[1].messages[2].content[0].type, 'tool_result');
    const followup = await generateText({
      model: createClaude().languageModel('claude-sonnet-4-6'),
      messages: [
        { role: 'user', content: 'Read the marker.' },
        ...(await result.responseMessages),
        { role: 'user', content: 'What was the marker?' },
      ],
      maxRetries: 0,
    });
    assert.equal(followup.text, 'The marker was blue.');
    assert.equal(followup.usage.outputTokens, 4);
    assert.equal(followup.usage.inputTokenDetails.cacheReadTokens, 2);
    assert.equal(followup.response.id, 'msg-1');
    assert.deepEqual(requests[2].cache_control, { type: 'ephemeral' });
    assert.ok(JSON.stringify(requests[2].messages).includes('blue'));
    assert.throws(() => claude.imageModel('unsupported'), NoSuchModelError);
  });
}

test('authentication is lazy and observes account changes without using API credentials', async (t) => {
  const home = await localHome(t);
  const model = claude('claude-sonnet-4-6');
  const tokens: (string | null)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: unknown, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('authorization'));
      return response('ok');
    },
  );
  await generateText({ model, prompt: 'hello', maxRetries: 0 });
  await writeFile(
    join(home, '.credentials.json'),
    JSON.stringify(login('access-b')),
  );
  await generateText({ model, prompt: 'hello', maxRetries: 0 });
  await writeFile(
    join(home, '.credentials.json'),
    JSON.stringify({ apiKey: 'wrong' }),
  );
  await assert.rejects(
    generateText({ model, prompt: 'hello', maxRetries: 0 }),
    /claude auth login/,
  );
  assert.deepEqual(tokens, ['Bearer access-a', 'Bearer access-b']);
});

for (const rotate of [true, false]) {
  test(`concurrent providers refresh once and preserve native fields (rotate=${rotate})`, async (t) => {
    const home = await localHome(t);
    const path = join(home, '.credentials.json');
    await writeFile(path, JSON.stringify(login('old', Date.now() + 30_000)));
    let refreshes = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/oauth/token')) {
          refreshes++;
          assert.deepEqual(JSON.parse(String(init?.body)), {
            grant_type: 'refresh_token',
            refresh_token: 'refresh-a',
            client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
            scope: 'user:inference user:profile',
          });
          return Response.json({
            access_token: 'fresh',
            ...(rotate && { refresh_token: 'rotated' }),
            expires_in: 3600,
          });
        }
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer fresh',
        );
        return response('ok');
      },
    );
    await Promise.all(
      [claude, createClaude()].map((provider) =>
        generateText({
          model: provider('claude-sonnet-4-6'),
          prompt: 'hello',
          maxRetries: 0,
        }),
      ),
    );
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(refreshes, 1);
    assert.equal(
      saved.claudeAiOauth.refreshToken,
      rotate ? 'rotated' : 'refresh-a',
    );
    assert.equal(saved.claudeAiOauth.subscriptionType, 'max');
    assert.deepEqual(saved.extra, { preserve: true });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
}

test('refresh cannot overwrite a newer native login', async (t) => {
  const home = await localHome(t);
  const path = join(home, '.credentials.json');
  await writeFile(path, JSON.stringify(login('old', Date.now() - 1000)));
  const newer = JSON.stringify(login('new-login'));
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/token')) {
        await writeFile(path, newer);
        return Response.json({
          access_token: 'stale-refresh',
          refresh_token: 'stale',
          expires_in: 3600,
        });
      }
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer new-login',
      );
      return response('ok');
    },
  );
  await generateText({
    model: claude('claude-sonnet-4-6'),
    prompt: 'hello',
    maxRetries: 0,
  });
  assert.equal(await readFile(path, 'utf8'), newer);
});

test('macOS uses the configured home keychain first and falls back only when absent', async (t) => {
  const home = await localHome(t, 'darwin');
  let password: string | undefined = JSON.stringify(
    login('keychain', Date.now() - 1000),
  );
  t.mock.module('@napi-rs/keyring', {
    namedExports: {
      AsyncEntry: class {
        constructor(service: string, account: string) {
          assert.equal(
            service,
            `Claude Code-credentials-${createHash('sha256').update(home.normalize('NFC')).digest('hex').slice(0, 8)}`,
          );
          assert.equal(account, process.env.USER);
        }
        async getPassword() {
          return password;
        }
        async setPassword(value: string) {
          password = value;
        }
      },
    },
  });
  const tokens: (string | null)[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/token'))
        return Response.json({
          access_token: 'keychain-fresh',
          refresh_token: 'rotated',
          expires_in: 3600,
        });
      tokens.push(new Headers(init?.headers).get('authorization'));
      return response('ok');
    },
  );
  await generateText({
    model: claude('claude-sonnet-4-6'),
    prompt: 'hello',
    maxRetries: 0,
  });
  assert.ok(password);
  assert.equal(JSON.parse(password).claudeAiOauth.refreshToken, 'rotated');
  password = undefined;
  await generateText({
    model: claude('claude-sonnet-4-6'),
    prompt: 'hello',
    maxRetries: 0,
  });
  password = 'malformed';
  await assert.rejects(
    generateText({
      model: claude('claude-sonnet-4-6'),
      prompt: 'hello',
      maxRetries: 0,
    }),
    /claude auth login/,
  );
  assert.deepEqual(tokens, ['Bearer keychain-fresh', 'Bearer access-a']);
});

test('refresh failures preserve credentials and hide server response bodies', async (t) => {
  const home = await localHome(t);
  const path = join(home, '.credentials.json');
  const original = JSON.stringify(login('old', Date.now() - 1000));
  await writeFile(path, original);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('sensitive-server-detail', { status: 401 }),
  );
  await assert.rejects(
    generateText({
      model: claude('claude-sonnet-4-6'),
      prompt: 'hello',
      maxRetries: 0,
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not refresh/);
      assert.doesNotMatch(error.message, /sensitive-server-detail/);
      return true;
    },
  );
  assert.equal(await readFile(path, 'utf8'), original);
});

for (const refresh of [true, false]) {
  test(`cancellation reaches ${refresh ? 'refresh' : 'model'} requests`, async (t) => {
    const home = await localHome(t);
    if (refresh)
      await writeFile(
        join(home, '.credentials.json'),
        JSON.stringify(login('old', Date.now() - 1000)),
      );
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
        model: claude('claude-sonnet-4-6'),
        prompt: 'hello',
        maxRetries: 0,
        abortSignal: controller.signal,
      }),
      { name: 'AbortError' },
    );
  });
}
