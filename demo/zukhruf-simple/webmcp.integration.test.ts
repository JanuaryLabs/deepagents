import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import declaration from '@deepagents/demo-zukhruf-simple';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

test('SimpleAgent discovers and executes a website tool through native WebMCP', async () => {
  await using server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html>
      <title>WebMCP integration</title>
      <output id="greeting"></output>
      <script type="module">
        await document.modelContext.registerTool({
          name: 'greet',
          description: 'Greet someone and display their greeting on the page.',
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
          },
          execute: ({ name }) => {
            document.querySelector('#greeting').textContent = 'Hello, ' + name + '!';
            return document.querySelector('#greeting').textContent;
          },
        });
      </script>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const calls: string[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      assert(tools?.some((tool) => tool.name === 'execute_webmcp_tool'));
      assert(
        tools?.some((tool) => tool.name === 'take_screenshot'),
        'tools outside the old six-tool selection are passed directly',
      );
      const results = prompt.flatMap((message) =>
        message.role === 'tool' ? message.content : [],
      );
      if (results.length === 3) {
        assert.match(JSON.stringify(results.at(-1)), /Hello, WebMCP!/);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: 'Hello, WebMCP!' },
              { type: 'text-end', id: 'text' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage,
              },
            ],
          }),
        };
      }

      let toolName: string;
      let input: Record<string, unknown>;
      if (results.length === 0) {
        toolName = 'new_page';
        input = { url: `http://127.0.0.1:${address.port}` };
      } else {
        const page = JSON.stringify(results[0]).match(
          /(\d+): WebMCP integration/,
        );
        assert(page, 'opening the page returns its real browser page ID');
        const pageId = Number(page[1]);
        if (results.length === 1) {
          toolName = 'list_webmcp_tools';
          input = { pageId };
        } else {
          const discovery = JSON.stringify(results.at(-1));
          assert.match(discovery, /greet/);
          assert.match(discovery, /inputSchema/);
          toolName = 'execute_webmcp_tool';
          input = {
            pageId,
            toolName: 'greet',
            input: JSON.stringify({ name: 'WebMCP' }),
          };
        }
      }
      calls.push(toolName);
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallId: `call-${results.length}`,
              toolName,
              input: JSON.stringify(input),
            },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
              usage,
            },
          ],
        }),
      };
    },
  });

  await using resources = new AsyncDisposableStack();
  const database = resources.adopt(new PGlite(), (database) =>
    database.close(),
  );
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => assert.fail(String(error)));
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (store) => store.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const browser = declaration.plugins.find(
    (plugin) => plugin.name === 'browser',
  );
  assert.ok(browser);
  const runtime = new AgentRuntime(
    defineAgent({
      ...declaration,
      model,
      plugins: [browser],
      sandbox: defineSandbox(async () =>
        createVirtualSandbox({ fs: new InMemoryFs() }),
      ),
    }),
  );
  const stack = defineStack(async () => ({
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore,
  }));
  const host = resources.use(await runtime.initialize(stack));
  resources.use(await host.work());
  const { stream } = await host.enqueue(
    { chatId: 'webmcp', userId: 'test' },
    {
      message: {
        id: 'request',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Open the supplied site, discover its WebMCP tools, and greet WebMCP.',
          },
        ],
      },
      trigger: 'submit-message',
    },
  );
  let text = '';
  for await (const part of stream) {
    if (part.type === 'error') assert.fail(part.errorText);
    if (part.type === 'text-delta') text += part.delta;
  }
  assert.equal(text, 'Hello, WebMCP!');
  assert.deepEqual(calls, [
    'new_page',
    'list_webmcp_tools',
    'execute_webmcp_tool',
  ]);
});
