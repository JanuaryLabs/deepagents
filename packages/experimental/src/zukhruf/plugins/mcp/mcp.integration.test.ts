import { type MCPClient, createMCPClient } from '@ai-sdk/mcp';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { TemporaryFiles } from '@zukhruf/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';

import {
  InMemoryContextStore,
  SqliteStreamStore,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  AgentRuntime,
  EmbeddedAgentStorage,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { mcp } from '@deepagents/experimental/zukhruf/mcp';

import { ControlledAgentStorage } from '../../../testing/controlled-agent-storage.fixture.ts';
import { streamsFor } from '../../../testing/streams-for.fixture.ts';
import { UnusedTurnQueue } from '../../../testing/unused-turn-queue.fixture.ts';
import { usage } from '../../../testing/usage.fixture.ts';

/** In-memory adapters for runtimes that are initialized but never worked. */
function adapters(resources: AsyncDisposableStack) {
  const streamStore = new SqliteStreamStore(':memory:');
  resources.defer(() => streamStore.close());
  return {
    store: new InMemoryContextStore(),
    streams: streamsFor(streamStore),
    queue: new UnusedTurnQueue(),
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

interface McpServerOptions {
  /** The tool names `tools/list` returns, or undefined to fail discovery. */
  tools(): string[] | undefined | Promise<never>;
  /**
   * Answers `tools/call` with the returned text. `disconnected` aborts when
   * the client drops the call's connection before the answer.
   */
  call(
    name: string,
    text: string,
    disconnected: AbortSignal,
  ): string | Promise<string>;
  /**
   * The server answers `initialize` once this settles. `disconnected` aborts
   * when the client drops the handshake's connection first.
   */
  handshake?(disconnected: AbortSignal): Promise<void>;
  sessions?: string[];
  closed?: string[];
}

/** Aborts when the client drops the connection before the response ends. */
function disconnectedSignal(response: ServerResponse) {
  const disconnected = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) disconnected.abort();
  });
  return disconnected.signal;
}

/** A real Streamable HTTP MCP server whose tools each take `{ text }`. */
async function startMcpServer(options: McpServerOptions) {
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method === 'DELETE') {
      options.closed?.push(String(request.headers['mcp-session-id']));
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = await Array.fromAsync(request);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    const reply = (result: unknown) =>
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result,
        }),
      );
    const tools =
      message.method === 'tools/list' ? await options.tools() : undefined;
    if (message.method === 'initialize') {
      await options.handshake?.(disconnectedSignal(response));
      const session = crypto.randomUUID();
      options.sessions?.push(session);
      response.setHeader('mcp-session-id', session);
      reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1.0.0' },
      });
    } else if (tools) {
      reply({
        tools: tools.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        })),
      });
    } else if (message.method === 'tools/call') {
      const text = await options.call(
        message.params.name,
        message.params.arguments.text,
        disconnectedSignal(response),
      );
      reply({ content: [{ type: 'text', text }] });
    } else {
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method unavailable' },
        }),
      );
    }
  };
  return new HttpServer().start((request, response) => {
    void respond(request, response);
  });
}

function connectTo(server: { origin: string }) {
  return () =>
    createMCPClient({
      transport: { type: 'http', url: server.origin },
      initializationOptions: { timeout: 5_000 },
    });
}

/**
 * Runs one turn of a root agent with the given plugins. The model calls the
 * tools in `toolCalls` on its first step and answers on its second; returns
 * the tool names the model was offered and the tool results it read. Once
 * `cancel.when` settles, the turn is cancelled through its observation, and
 * the runtime stays up until `cancel.observed` settles.
 */
async function runTurn(
  plugins: ReturnType<typeof mcp>[],
  toolCalls: { toolName: string; text: string }[] = [],
  cancel?: { when: Promise<unknown>; observed: Promise<unknown> },
) {
  const offered: string[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt, tools }) => {
      offered.push((tools ?? []).map((tool) => tool.name));
      const answered = prompt.some((message) => message.role === 'tool');
      const chunks: LanguageModelV4StreamPart[] =
        answered || toolCalls.length === 0
          ? [
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: 'done' },
              { type: 'text-end', id: 'text' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage,
              },
            ]
          : [
              ...toolCalls.map(
                ({ toolName, text }, index): LanguageModelV4StreamPart => ({
                  type: 'tool-call',
                  toolCallId: `call-${index}`,
                  toolName,
                  input: JSON.stringify({ text }),
                }),
              ),
              {
                type: 'finish',
                finishReason: {
                  unified: 'tool-calls',
                  raw: 'tool-calls',
                },
                usage,
              },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  await using resources = new AsyncDisposableStack();
  const directory = resources.use(
    await new TemporaryFiles().directory('zukhruf-mcp-test-'),
  );
  const storage = resources.use(
    await EmbeddedAgentStorage.open({ directory: directory.path }),
  );
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model,
      instructions: [],
      sandbox: defineSandbox(new VirtualSandboxEnvironment()),
      plugins,
    }),
  );
  const host = resources.use(
    await runtime.initialize(defineStack(async () => ({ storage }))),
  );
  resources.use(await host.work());
  const conversation = { chatId: 'mcp', userId: 'test' };
  const { stream } = await host.enqueue(conversation, {
    message: {
      id: 'request',
      role: 'user',
      parts: [{ type: 'text', text: 'Use the tools.' }],
    },
    trigger: 'submit-message',
  });
  const cancelled = cancel?.when.then(() =>
    host.observe(conversation).cancel(),
  );
  const results: unknown[] = [];
  for await (const part of stream) {
    if (part.type === 'error') assert.fail(part.errorText);
    if (part.type === 'tool-input-error' || part.type === 'tool-output-error') {
      assert.fail(part.errorText);
    }
    if (part.type === 'tool-output-available') results.push(part.output);
  }
  await cancelled;
  await cancel?.observed;
  return { offered, results };
}

/** Initializes a runtime whose root agent has only the given plugin. */
async function initialize(plugin: ReturnType<typeof mcp>) {
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4(),
      instructions: [],
      sandbox: defineSandbox(new VirtualSandboxEnvironment()),
      plugins: [plugin],
    }),
  );
  return runtime.initialize(
    defineStack(async (resources) => ({
      storage: new ControlledAgentStorage(adapters(resources)),
    })),
  );
}

/** Resolves on the server's first DELETE, the client closing its session. */
function sessionDeleted(server: { server: Server }) {
  return new Promise<void>((resolve) =>
    server.server.on('request', (request: IncomingMessage) => {
      if (request.method === 'DELETE') resolve();
    }),
  );
}

/** The MCP tool names the model is offered, sorted. */
function mcpToolNames(offered: string[][]) {
  return offered[0].filter((name) => name.startsWith('mcp__')).sort();
}

test('MCP uses real HTTP clients per runtime and closes them on failure or disposal', async () => {
  let failDiscovery = false;
  let discoveryRequests = 0;
  const sessions: string[] = [];
  const closed: string[] = [];
  await using server = await startMcpServer({
    tools() {
      if (failDiscovery) return undefined;
      discoveryRequests++;
      return ['echo'];
    },
    call: (_name, text) => text,
    sessions,
    closed,
  });
  const clients: MCPClient[] = [];
  const connection = mcp({
    name: 'http-tools',
    async connect() {
      const client = await connectTo(server)();
      clients.push(client);
      return client;
    },
  });
  // This test exercises initialization only; no queue, model, or sandbox is used.
  const root = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4(),
    instructions: [],
    sandbox: {
      environment: new VirtualSandboxEnvironment(),
      open: async () => {
        throw new Error('sandbox must not be called');
      },
    },
    plugins: [connection],
  });
  const stack = defineStack(async (resources) => ({
    storage: new ControlledAgentStorage(adapters(resources)),
  }));
  const firstSetup = new AgentRuntime(root);
  await using first = await firstSetup.initialize(stack);
  const secondSetup = new AgentRuntime(root);
  await using second = await secondSetup.initialize(stack);
  assert.equal(clients.length, 2);
  assert.equal(discoveryRequests, 2);
  assert.notEqual(sessions[0], sessions[1]);

  await first[Symbol.asyncDispose]();
  assert.deepEqual(closed, [sessions[0]]);
  const result = await clients[1].callTool({
    name: 'echo',
    arguments: { text: 'still connected' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'still connected' }]);
  await second[Symbol.asyncDispose]();
  assert.deepEqual(closed, sessions);

  failDiscovery = true;
  const discoveryRuntime = new AgentRuntime(root);
  await assert.rejects(
    discoveryRuntime.initialize(stack),
    /Method unavailable/,
  );
  assert.deepEqual(closed, sessions, 'failed discovery closes its client');

  failDiscovery = false;
  const failingRuntime = new AgentRuntime(
    defineAgent({
      ...root,
      plugins: [
        connection,
        {
          name: 'fail',
          create: () => ({
            async initialize() {
              throw new Error('later failure');
            },
          }),
        },
      ],
    }),
  );
  await assert.rejects(failingRuntime.initialize(stack), /later failure/);
  assert.deepEqual(
    closed,
    sessions,
    'later initialization failure closes the MCP client',
  );
});

test('two MCP servers that expose the same tool name run together, and each call reaches its own server under the original name', async () => {
  const alphaCalls: string[] = [];
  const betaCalls: string[] = [];
  await using alpha = await startMcpServer({
    tools: () => ['search'],
    call(name, text) {
      alphaCalls.push(`${name}:${text}`);
      return `alpha found ${text}`;
    },
  });
  await using beta = await startMcpServer({
    tools: () => ['search'],
    call(name, text) {
      betaCalls.push(`${name}:${text}`);
      return `beta found ${text}`;
    },
  });

  const { offered, results } = await runTurn(
    [
      mcp({ name: 'alpha', connect: connectTo(alpha) }),
      mcp({ name: 'beta', connect: connectTo(beta) }),
    ],
    [
      { toolName: 'mcp__alpha__search', text: 'cats' },
      { toolName: 'mcp__beta__search', text: 'dogs' },
    ],
  );

  assert.deepStrictEqual(mcpToolNames(offered), [
    'mcp__alpha__search',
    'mcp__beta__search',
  ]);
  assert.ok(!offered[0].includes('search'), 'the raw name is not offered');
  assert.deepStrictEqual(alphaCalls, ['search:cats']);
  assert.deepStrictEqual(betaCalls, ['search:dogs']);
  assert.match(JSON.stringify(results), /alpha found cats/);
  assert.match(JSON.stringify(results), /beta found dogs/);
});

test('characters outside [A-Za-z0-9_] in the server or tool name become underscores', async () => {
  const calls: string[] = [];
  await using server = await startMcpServer({
    tools: () => ['get.items/🔍'],
    call(name, text) {
      calls.push(`${name}:${text}`);
      return text;
    },
  });

  const { offered } = await runTurn(
    [mcp({ name: 'my-server.v2', connect: connectTo(server) })],
    [{ toolName: 'mcp__my_server_v2__get_items__', text: 'all' }],
  );

  assert.deepStrictEqual(mcpToolNames(offered), [
    'mcp__my_server_v2__get_items__',
  ]);
  assert.deepStrictEqual(calls, ['get.items/🔍:all']);
});

test('a server already named mcp__ is not prefixed twice, and a server name too long for any tool keeps a 128-character name', async () => {
  const calls: string[] = [];
  await using server = await startMcpServer({
    tools: () => ['x'],
    call(name) {
      calls.push(name);
      return 'ok';
    },
  });
  const longServer = 'c'.repeat(130);
  const cut = `mcp__${'c'.repeat(108)}___5ab341c555b0`;

  const { offered } = await runTurn(
    [
      mcp({ name: 'mcp__notes', connect: connectTo(server) }),
      mcp({ name: longServer, connect: connectTo(server) }),
    ],
    [
      { toolName: 'mcp__notes__x', text: 'a' },
      { toolName: cut, text: 'b' },
    ],
  );

  assert.deepStrictEqual(mcpToolNames(offered), [cut, 'mcp__notes__x']);
  assert.equal(cut.length, 128);
  assert.deepStrictEqual(calls, ['x', 'x']);
});

test('a model-facing name over 128 characters is cut to 128 with a 12-hex sha1 suffix', async () => {
  const fits = 'a'.repeat(116);
  const overflows = 'b'.repeat(117);
  const calls: string[] = [];
  await using server = await startMcpServer({
    tools: () => [fits, overflows],
    call(name) {
      calls.push(name);
      return 'ok';
    },
  });
  const capped = `mcp__alpha__${'b'.repeat(103)}_c8f903e30ac1`;

  const { offered } = await runTurn(
    [mcp({ name: 'alpha', connect: connectTo(server) })],
    [{ toolName: capped, text: 'x' }],
  );

  assert.deepStrictEqual(mcpToolNames(offered), [
    `mcp__alpha__${fits}`,
    capped,
  ]);
  assert.equal(capped.length, 128);
  assert.deepStrictEqual(calls, [overflows]);
});

test('two tools that sanitize to the same name get distinct names that every runtime derives alike', async () => {
  const calls: string[] = [];
  await using server = await startMcpServer({
    tools: () => ['tool-name', 'tool_name'],
    call(name, text) {
      calls.push(`${name}:${text}`);
      return 'ok';
    },
  });
  const plugin = mcp({ name: 'alpha', connect: connectTo(server) });
  const expected = [
    'mcp__alpha__tool_name_04c7d13f636e',
    'mcp__alpha__tool_name_5d5ca057cf75',
  ];

  const first = await runTurn(
    [plugin],
    [
      { toolName: 'mcp__alpha__tool_name_5d5ca057cf75', text: 'dash' },
      { toolName: 'mcp__alpha__tool_name_04c7d13f636e', text: 'underscore' },
    ],
  );
  const second = await runTurn([plugin]);

  assert.deepStrictEqual(mcpToolNames(first.offered), expected);
  assert.deepStrictEqual(mcpToolNames(second.offered), expected);
  assert.deepStrictEqual(calls.sort(), [
    'tool-name:dash',
    'tool_name:underscore',
  ]);
});

test(
  'a tool call the server never answers ends at toolTimeoutMs with the error result Codex gives, while a call beside it answers and the turn goes on',
  { timeout: 10_000 },
  async () => {
    const dropped = Promise.withResolvers<void>();
    await using server = await startMcpServer({
      tools: () => ['slow', 'fast'],
      call(name, text, disconnected) {
        if (name === 'fast') return `fast ${text}`;
        disconnected.addEventListener('abort', () => dropped.resolve());
        return new Promise<never>(() => {});
      },
    });

    const { offered, results } = await runTurn(
      [
        mcp({
          name: 'alpha',
          connect: connectTo(server),
          toolTimeoutMs: 1_500,
        }),
      ],
      [
        { toolName: 'mcp__alpha__slow', text: 'x' },
        { toolName: 'mcp__alpha__fast', text: 'y' },
      ],
    );

    assert.deepStrictEqual(results, [
      { content: [{ type: 'text', text: 'fast y' }], isError: false },
      {
        content: [
          {
            type: 'text',
            text: 'tool call error: tool call failed for `alpha/slow`\n\nCaused by:\n    timed out awaiting tools/call after 2s',
          },
        ],
        isError: true,
      },
    ]);
    assert.equal(offered.length, 2, 'the model reads the result and answers');
    await dropped.promise;
  },
);

test(
  'a tool call answered within toolTimeoutMs returns the server answer',
  { timeout: 10_000 },
  async () => {
    await using server = await startMcpServer({
      tools: () => ['slow'],
      async call(_name, text) {
        await setTimeout(300);
        return `late ${text}`;
      },
    });

    const { results } = await runTurn(
      [
        mcp({
          name: 'alpha',
          connect: connectTo(server),
          toolTimeoutMs: 2_000,
        }),
      ],
      [{ toolName: 'mcp__alpha__slow', text: 'answer' }],
    );

    assert.deepStrictEqual(results, [
      { content: [{ type: 'text', text: 'late answer' }], isError: false },
    ]);
  },
);

test(
  'cancelling the turn drops a pending tool call at once',
  { timeout: 10_000 },
  async () => {
    const arrived = Promise.withResolvers<void>();
    const dropped = Promise.withResolvers<void>();
    await using server = await startMcpServer({
      tools: () => ['slow'],
      call(_name, _text, disconnected) {
        disconnected.addEventListener('abort', () => dropped.resolve());
        arrived.resolve();
        return new Promise<never>(() => {});
      },
    });

    const { results } = await runTurn(
      [
        mcp({
          name: 'alpha',
          connect: connectTo(server),
          toolTimeoutMs: 60_000,
        }),
      ],
      [{ toolName: 'mcp__alpha__slow', text: 'x' }],
      { when: arrived.promise, observed: dropped.promise },
    );

    assert.deepStrictEqual(results, []);
  },
);

test(
  'a server that never answers the handshake fails runtime start at connectTimeoutMs, and the connect factory gets the deadline signal',
  { timeout: 10_000 },
  async () => {
    const dropped = Promise.withResolvers<void>();
    await using server = await startMcpServer({
      tools: () => ['echo'],
      call: (_name, text) => text,
      handshake(disconnected) {
        disconnected.addEventListener('abort', () => dropped.resolve());
        return new Promise<never>(() => {});
      },
    });

    await assert.rejects(
      initialize(
        mcp({
          name: 'alpha',
          connect: ({ signal }) =>
            createMCPClient({
              transport: { type: 'http', url: server.origin },
              initializationOptions: { signal },
            }),
          connectTimeoutMs: 1_500,
        }),
      ),
      {
        message:
          'required MCP servers failed to initialize: alpha: MCP client startup timed out after 1.5s',
      },
    );
    await dropped.promise;
  },
);

test(
  'a connect factory that ignores the deadline still fails runtime start at connectTimeoutMs, and the client it delivers late is closed',
  { timeout: 10_000 },
  async () => {
    const release = Promise.withResolvers<void>();
    await using server = await startMcpServer({
      tools: () => ['echo'],
      call: (_name, text) => text,
      handshake: () => release.promise,
    });
    const deleted = sessionDeleted(server);

    await assert.rejects(
      initialize(
        mcp({
          name: 'alpha',
          connect: () =>
            createMCPClient({
              transport: { type: 'http', url: server.origin },
            }),
          connectTimeoutMs: 300,
        }),
      ),
      {
        message:
          'required MCP servers failed to initialize: alpha: MCP client startup timed out after 300ms',
      },
    );
    release.resolve();
    await deleted;
  },
);

test(
  'a server that never lists its tools fails runtime start at connectTimeoutMs and its client is closed',
  { timeout: 10_000 },
  async () => {
    await using server = await startMcpServer({
      tools: () => new Promise<never>(() => {}),
      call: (_name, text) => text,
    });
    const deleted = sessionDeleted(server);

    await assert.rejects(
      initialize(
        mcp({
          name: 'alpha',
          connect: connectTo(server),
          connectTimeoutMs: 2_400,
        }),
      ),
      {
        message:
          'required MCP servers failed to initialize: alpha: timed out awaiting tools/list after 2s',
      },
    );
    await deleted;
  },
);
