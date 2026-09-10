import { type MCPClient, createMCPClient } from '@ai-sdk/mcp';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  AgentRuntime,
  type AgentRuntimeOptions,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
import { mcp } from '@deepagents/experimental/zukhruf/mcp';

test('MCP uses real HTTP clients per runtime and closes them on failure or disposal', async () => {
  let failDiscovery = false;
  let discoveryRequests = 0;
  const sessions: string[] = [];
  const closed: string[] = [];
  await using server = createServer(async (request, response) => {
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
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const clients: MCPClient[] = [];
  const connection = mcp({
    name: 'http-tools',
    async connect() {
      const client = await createMCPClient({
        transport: { type: 'http', url: `http://127.0.0.1:${address.port}` },
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
  const options = {} as AgentRuntimeOptions;
  await using first = new AgentRuntime(root, options);
  await using second = new AgentRuntime(root, options);
  assert.equal(
    clients.length,
    0,
    'declaring and constructing does not connect',
  );
  await Promise.all([first.initialize(), first.initialize()]);
  await second.initialize();
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
  await using failed = new AgentRuntime(root, options);
  await assert.rejects(failed.initialize(), /Method unavailable/);
  assert.deepEqual(closed, sessions, 'failed discovery closes its client');

  failDiscovery = false;
  await using laterFailure = new AgentRuntime(
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
    options,
  );
  await assert.rejects(laterFailure.initialize(), /later failure/);
  assert.deepEqual(
    closed,
    sessions,
    'later initialization failure closes the MCP client',
  );
});
