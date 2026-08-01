import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type IndexLock, Text2Sql } from '@deepagents/text2sql';
import {
  PostHog,
  PostHogApiError,
  type PostHogQueryRequest,
  type PostHogTransport,
  createPostHogTransport,
  definitions,
  info,
  schema,
} from '@deepagents/text2sql/posthog';

const validMetadata = (tableNames: string[] = []) => ({
  isValid: true,
  errors: [],
  warnings: [],
  notices: [],
  table_names: tableNames,
});

it('uses the native HTTP transport with rotating bearer tokens and local pagination', async () => {
  const requests: Array<{
    method?: string;
    url?: string;
    authorization?: string;
    body: unknown;
  }> = [];
  const server = await startServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body,
    });

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname.endsWith('/query/')) {
      return json(response, { results: [[1]], columns: ['value'] });
    }
    if (url.pathname.endsWith('/event_definitions/')) {
      const offset = url.searchParams.get('offset');
      return json(
        response,
        offset === '0'
          ? { next: 'https://attacker.invalid/page', results: [{ name: 'a' }] }
          : { next: null, results: [{ name: 'b' }] },
      );
    }
    if (url.pathname.endsWith('/property_definitions/')) {
      return json(response, { next: null, results: [{ name: 'company' }] });
    }
    response.writeHead(404).end();
  });

  let tokenCalls = 0;
  try {
    const transport = createPostHogTransport({
      host: server.origin,
      projectId: 'project/1',
      getAccessToken: () => `token-${++tokenCalls}`,
    });

    assert.deepEqual(
      await transport.query({
        query: { kind: 'HogQLQuery', query: 'SELECT 1' },
        name: 'smoke',
      }),
      { results: [[1]], columns: ['value'] },
    );
    assert.deepEqual(
      (await transport.listEventDefinitions()).map(({ name }) => name),
      ['a', 'b'],
    );
    assert.deepEqual(
      (
        await transport.listPropertyDefinitions({
          type: 'group',
          groupTypeIndex: 2,
        })
      ).map(({ name }) => name),
      ['company'],
    );

    assert.equal(tokenCalls, 4);
    assert.deepEqual(
      requests.map(({ authorization }) => authorization),
      ['Bearer token-1', 'Bearer token-2', 'Bearer token-3', 'Bearer token-4'],
    );
    assert.equal(requests[0]?.method, 'POST');
    assert.equal(requests[0]?.url, '/api/projects/project%2F1/query/');
    assert.deepEqual(requests[0]?.body, {
      query: { kind: 'HogQLQuery', query: 'SELECT 1' },
      name: 'smoke',
    });
    assert.match(requests[1]?.url ?? '', /exclude_hidden=true/);
    assert.match(requests[1]?.url ?? '', /exclude_stale=true/);
    assert.match(requests[2]?.url ?? '', /offset=1/);
    assert.match(requests[3]?.url ?? '', /group_type_index=2/);
  } finally {
    await server.close();
  }
});

it('reports API failures without leaking the bearer token', async () => {
  const server = await startServer(async (_request, response) => {
    response.setHeader('retry-after', '2');
    json(
      response,
      { code: 'throttled', detail: 'Slow down secret-token' },
      429,
    );
  });

  try {
    const transport = createPostHogTransport({
      host: server.origin,
      projectId: 42,
      getAccessToken: () => 'secret-token',
    });
    await assert.rejects(
      transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
      (error: unknown) => {
        assert.ok(error instanceof PostHogApiError);
        assert.equal(error.status, 429);
        assert.equal(error.code, 'throttled');
        assert.equal(error.detail, 'Slow down [REDACTED]');
        assert.equal(error.retryAfterMs, 2_000);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

it('does not retain bearer tokens in injected fetch failures', async () => {
  const transport = createPostHogTransport({
    host: 'https://posthog.example.com',
    projectId: 42,
    getAccessToken: () => 'secret-token',
    fetch: async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      throw new Error(`Injected fetch failed with ${authorization}`);
    },
  });

  await assert.rejects(
    transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /secret-token/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

it('parses HTTP-date Retry-After headers', async () => {
  const retryAt = Date.now() + 60_000;
  const transport = createPostHogTransport({
    host: 'https://posthog.example.com',
    projectId: 42,
    getAccessToken: () => 'token',
    fetch: async () =>
      new Response(JSON.stringify({ detail: 'Slow down' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': new Date(retryAt).toUTCString(),
        },
      }),
  });

  await assert.rejects(
    transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
    (error: unknown) => {
      assert.ok(error instanceof PostHogApiError);
      assert.ok((error.retryAfterMs ?? 0) >= 58_000);
      assert.ok((error.retryAfterMs ?? Infinity) <= 60_000);
      return true;
    },
  );
});

it('accepts IPv6 loopback development hosts', () => {
  assert.doesNotThrow(() =>
    createPostHogTransport({
      host: 'http://[::1]:8000',
      projectId: 1,
      getAccessToken: () => 'token',
      fetch: async () => new Response('{}'),
    }),
  );
});

it('rejects unsafe hosts, redirects, and timed-out requests', async () => {
  assert.throws(
    () =>
      createPostHogTransport({
        host: 'http://posthog.example.com',
        projectId: 1,
        getAccessToken: () => 'token',
      }),
    /must use HTTPS/,
  );

  const redirectServer = await startServer(async (_request, response) => {
    response.writeHead(302, { location: 'https://attacker.invalid/' }).end();
  });
  try {
    const transport = createPostHogTransport({
      host: redirectServer.origin,
      projectId: 1,
      getAccessToken: () => 'token',
    });
    await assert.rejects(
      transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
      /failed before receiving a response/,
    );
  } finally {
    await redirectServer.close();
  }

  const slowServer = await startServer(async (_request, response) => {
    await sleep(100);
    json(response, { results: [] });
  });
  try {
    const transport = createPostHogTransport({
      host: slowServer.origin,
      projectId: 1,
      getAccessToken: () => 'token',
      timeoutMs: 10,
    });
    await assert.rejects(
      transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
      /timed out after 10ms/,
    );
  } finally {
    await slowServer.close();
  }

  const slowBodyServer = await startServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"results":');
    await sleep(100);
    response.end('[]}');
  });
  try {
    const transport = createPostHogTransport({
      host: slowBodyServer.origin,
      projectId: 1,
      getAccessToken: () => 'token',
      timeoutMs: 10,
    });
    await assert.rejects(
      transport.query({ query: { kind: 'HogQLQuery', query: 'SELECT 1' } }),
      /timed out after 10ms/,
    );
  } finally {
    await slowBodyServer.close();
  }
});

it('validates HogQL scope server-side and normalizes query rows', async () => {
  const queryKinds: string[] = [];
  const transport: PostHogTransport = {
    async query<T>(request: PostHogQueryRequest): Promise<T> {
      queryKinds.push(request.query.kind);
      if (request.query.kind === 'DatabaseSchemaQuery') {
        return schemaFixture() as T;
      }
      if (request.query.kind === 'HogQLMetadata') {
        if (request.query.query.includes('missing_metadata')) {
          return {
            isValid: true,
            errors: [],
            warnings: [],
            notices: [],
          } as T;
        }
        if (request.query.query.includes('DROP')) {
          return {
            isValid: false,
            errors: [{ message: 'Expected a SELECT query' }],
            warnings: [],
            notices: [],
            table_names: [],
          } as T;
        }
        return validMetadata(
          request.query.query.includes('secrets') ? ['secrets'] : ['events'],
        ) as T;
      }
      return {
        columns: ['event', 'count'],
        results: [['signup', 3]],
      } as T;
    },
    async listEventDefinitions() {
      return [];
    },
    async listPropertyDefinitions() {
      return [];
    },
  };
  const adapter = new PostHog({ transport, grounding: [schema()] });

  assert.deepEqual(
    await adapter.execute('SELECT event, count() AS count FROM events'),
    [{ event: 'signup', count: 3 }],
  );
  assert.deepEqual(queryKinds, [
    'HogQLMetadata',
    'DatabaseSchemaQuery',
    'HogQLQuery',
  ]);

  await assert.rejects(
    adapter.execute('SELECT * FROM secrets'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'SQLScopeError');
      const payload = JSON.parse(error.message) as {
        error_type: string;
        referenced_entities: string[];
      };
      assert.equal(payload.error_type, 'OUT_OF_SCOPE');
      assert.deepEqual(payload.referenced_entities, ['secrets']);
      return true;
    },
  );
  const invalid = await adapter.validate('DROP TABLE events');
  assert.match(invalid ?? '', /SQL_SCOPE_PARSE_ERROR/);
  assert.match(invalid ?? '', /Expected a SELECT query/);
  const missingMetadata = await adapter.validate(
    'SELECT * FROM missing_metadata',
  );
  assert.match(missingMetadata ?? '', /SQL_SCOPE_PARSE_ERROR/);
  assert.match(missingMetadata ?? '', /table_names/);
});

it('propagates operational metadata failures', async () => {
  const failure = new PostHogApiError({
    status: 401,
    message: 'PostHog access token expired.',
  });
  const transport: PostHogTransport = {
    async query(): Promise<never> {
      throw failure;
    },
    async listEventDefinitions() {
      return [];
    },
    async listPropertyDefinitions() {
      return [];
    },
  };
  const adapter = new PostHog({ transport });

  await assert.rejects(() => adapter.validate('SELECT 1'), failure);
  await assert.rejects(() => adapter.execute('SELECT 1'), failure);
});

it('rejects ambiguous or malformed HogQL result rows', async () => {
  const responses = [
    { columns: ['value', 'value'], results: [] },
    { columns: ['value', 'value'], results: [[1, 2]] },
    { columns: ['value'], results: [[1, 2]] },
    { results: [[1]] },
  ];
  const transport: PostHogTransport = {
    async query<T>(request: PostHogQueryRequest): Promise<T> {
      if (request.query.kind === 'DatabaseSchemaQuery') {
        return schemaFixture() as T;
      }
      if (request.query.kind === 'HogQLMetadata') {
        return validMetadata(['events']) as T;
      }
      return responses.shift() as T;
    },
    async listEventDefinitions() {
      return [];
    },
    async listPropertyDefinitions() {
      return [];
    },
  };
  const adapter = new PostHog({ transport, grounding: [schema()] });

  await assert.rejects(
    adapter.execute('SELECT 1 FROM events'),
    /duplicate column names/,
  );
  await assert.rejects(
    adapter.execute('SELECT 1 FROM events'),
    /duplicate column names/,
  );
  await assert.rejects(
    adapter.execute('SELECT 1 FROM events'),
    /does not match the column count/,
  );
  await assert.rejects(
    adapter.execute('SELECT 1 FROM events'),
    /requires columns/,
  );
});

it('maps PostHog schema, joins, and filtered taxonomy into context fragments', async () => {
  const transport: PostHogTransport = {
    async query<T>(request: PostHogQueryRequest): Promise<T> {
      assert.equal(request.query.kind, 'DatabaseSchemaQuery');
      return schemaFixture() as T;
    },
    async listEventDefinitions() {
      return [
        {
          name: 'signup',
          description: 'Account created',
          tags: ['activation'],
          verified: true,
        },
        { name: 'pageview' },
      ];
    },
    async listPropertyDefinitions({ type, groupTypeIndex }) {
      return [
        {
          name: type === 'group' ? `company_${groupTypeIndex}` : `${type}_plan`,
          property_type: 'String',
          verified: true,
        },
        { name: 'ignored' },
      ];
    },
  };
  const adapter = new PostHog({
    transport,
    grounding: [
      info(),
      schema({
        columns: {
          events: ['event', 'team_id'],
          active_users: ['event'],
        },
      }),
      definitions({
        events: ['signup'],
        properties: /_plan$|^company_/,
        groupTypeIndexes: [1],
      }),
    ],
  });

  const fragments = await adapter.introspect();
  const fragment = (name: string) =>
    fragments.find((candidate) => candidate.name === name);
  const events = fragments.find(
    (candidate) =>
      candidate.name === 'table' &&
      (candidate.data as { name?: string })?.name === 'events',
  );
  const activeUsers = fragments.find(
    (candidate) =>
      candidate.name === 'view' &&
      (candidate.data as { name?: string })?.name === 'active_users',
  );

  assert.equal(
    (fragment('dialectInfo')?.data as { dialect?: string }).dialect,
    'HogQL',
  );
  assert.deepEqual(
    (
      (events?.data as { columns?: Array<{ data: { name: string } }> })
        .columns ?? []
    ).map((column) => column.data.name),
    ['event', 'team_id'],
  );
  assert.equal(
    Object.hasOwn((events?.data ?? {}) as object, 'rowCount'),
    false,
  );
  assert.equal(
    (activeUsers?.data as { definition?: string }).definition,
    'SELECT event FROM events',
  );
  assert.equal(
    fragments.some(
      (candidate) =>
        candidate.name === 'table' &&
        (candidate.data as { name?: string })?.name === 'query_log',
    ),
    false,
  );
  assert.ok(fragment('relationship'));
  assert.equal(
    fragments.filter((candidate) => candidate.name === 'relationship').length,
    1,
  );
  assert.deepEqual(fragment('posthogEvents')?.data, [
    {
      name: 'signup',
      description: 'Account created',
      tags: ['activation'],
      verified: true,
    },
  ]);
  assert.deepEqual(Object.keys(fragment('posthogProperties')?.data as object), [
    'event',
    'person',
    'session',
    'group:1',
  ]);
});

it('runs generated HogQL through the public Text2Sql flow', async () => {
  let metadataCalls = 0;
  const transport: PostHogTransport = {
    async query<T>(request: PostHogQueryRequest): Promise<T> {
      if (request.query.kind === 'DatabaseSchemaQuery') {
        return schemaFixture() as T;
      }
      if (request.query.kind === 'HogQLMetadata') {
        metadataCalls++;
        return validMetadata(['events']) as T;
      }
      return { columns: ['signups'], results: [[7]] } as T;
    },
    async listEventDefinitions() {
      return [];
    },
    async listPropertyDefinitions() {
      return [];
    },
  };
  const adapter = new PostHog({ transport, grounding: [schema()] });
  const text2sql = new Text2Sql({
    adapters: { analytics: adapter },
    model: mockModel('SELECT count() AS signups FROM events'),
    lock: passthroughLock,
  });

  const sql = await text2sql.toSql('How many events are there?', 'analytics');
  assert.match(sql, /SELECT\s+count\(\) AS signups/i);
  const metadataBeforeRun = metadataCalls;
  assert.deepEqual(await text2sql.run('analytics', sql), {
    rows: [{ signups: 7 }],
    columns: ['signups'],
  });
  assert.equal(metadataCalls - metadataBeforeRun, 2);
});

const passthroughLock: IndexLock = {
  async run<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};

function schemaFixture() {
  const field = (name: string, type: string, schemaValid = true) => ({
    name,
    hogql_value: name,
    type,
    schema_valid: schemaValid,
  });
  return {
    tables: {
      events: {
        type: 'posthog',
        id: 'events',
        name: 'events',
        row_count: null,
        fields: {
          event: {
            ...field('Event display name', 'string'),
            hogql_value: 'event',
          },
          team_id: field('team_id', 'integer'),
          properties: field('properties', 'json'),
          person: field('person', 'lazy_table'),
          invalid: field('invalid', 'string', false),
        },
      },
      teams: {
        type: 'data_warehouse',
        id: 'teams',
        name: 'teams',
        fields: { id: field('id', 'integer') },
      },
      active_users: {
        type: 'materialized_view',
        id: 'active_users',
        name: 'active_users',
        fields: {
          event: field('event', 'string'),
          team_id: field('team_id', 'integer'),
        },
        query: { query: 'SELECT event FROM events' },
      },
      query_log: {
        type: 'system',
        id: 'query_log',
        name: 'query_log',
        fields: { query: field('query', 'string') },
      },
    },
    joins: [
      {
        source_table_name: 'events',
        source_table_key: 'team_id',
        joining_table_name: 'teams',
        joining_table_key: 'id',
        field_name: 'team',
      },
      {
        source_table_name: 'active_users',
        source_table_key: 'team_id',
        joining_table_name: 'teams',
        joining_table_key: 'id',
        field_name: 'team',
      },
      { source_table_name: 'events' },
    ],
  };
}

function mockModel(sql: string) {
  const response: LanguageModelV4GenerateResult = {
    finishReason: { unified: 'stop', raw: '' },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    content: [
      {
        type: 'text',
        text: JSON.stringify({ result: { sql, reasoning: 'test' } }),
      },
    ],
    warnings: [],
  };
  return new MockLanguageModelV4({ doGenerate: response });
}

async function startServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
