import { type MCPClient, createMCPClient } from '@ai-sdk/mcp';
import { HttpServer } from '@zukhruf/testing/http';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';

import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import {
  AgentRuntime,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { mcp } from '@deepagents/experimental/zukhruf/mcp';

/** Turns are never scheduled by runtimes that are only initialized. */
class UnusedTurnQueue extends TurnQueue {
  override async push(): Promise<void> {
    throw unusedQueue();
  }

  override async getTurnActivity(): Promise<TurnActivity> {
    throw unusedQueue();
  }

  override async getCurrentTurn(): Promise<TurnRef | undefined> {
    throw unusedQueue();
  }

  override async cancel(): Promise<void> {
    throw unusedQueue();
  }

  override async consume(): Promise<AsyncDisposable> {
    throw unusedQueue();
  }

  override async resumeParked(): Promise<void> {
    throw unusedQueue();
  }
}

function unusedQueue(): Error {
  return new Error('this test never schedules a turn');
}

/** In-memory adapters for runtimes that are initialized but never worked. */
function adapters(resources: AsyncDisposableStack) {
  const streamStore = new SqliteStreamStore(':memory:');
  resources.defer(() => streamStore.close());
  return {
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue: new UnusedTurnQueue(),
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

test('MCP uses real HTTP clients per runtime and closes them on failure or disposal', async () => {
  let failDiscovery = false;
  let discoveryRequests = 0;
  const sessions: string[] = [];
  const closed: string[] = [];
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    if (request.method === 'DELETE') {
      closed.push(String(request.headers['mcp-session-id']));
      response.writeHead(200).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
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
    if (message.method === 'initialize') {
      const session = crypto.randomUUID();
      sessions.push(session);
      response.setHeader('mcp-session-id', session);
      reply({
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list' && !failDiscovery) {
      discoveryRequests++;
      reply({
        tools: [
          {
            name: 'echo',
            description: 'Echo text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
    } else if (message.method === 'tools/call') {
      reply({
        content: [{ type: 'text', text: message.params.arguments.text }],
      });
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
  await using server = await new HttpServer().start((request, response) => {
    void respond(request, response);
  });
  const clients: MCPClient[] = [];
  const connection = mcp({
    name: 'http-tools',
    async connect() {
      const client = await createMCPClient({
        transport: { type: 'http', url: server.origin },
        initializationOptions: { timeout: 5_000 },
      });
      clients.push(client);
      return client;
    },
  });
  // This test exercises initialization only; no queue, model, or sandbox is used.
  const root = defineAgent({
    name: 'root',
    model: new MockLanguageModelV4(),
    instructions: [],
    sandbox: async () => {
      throw new Error('sandbox must not be called');
    },
    plugins: [connection],
  });
  const stack = defineStack(async (resources) => adapters(resources));
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
