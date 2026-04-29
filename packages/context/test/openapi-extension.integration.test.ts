import nock from 'nock';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  type ExtensionCommandContext,
  type Sandbox,
  createOpenAPIExtension,
} from '@deepagents/context';

const API_HOST = 'https://api.example.test';

async function writeSpec(
  spec: unknown,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-extension-'));
  const path = join(dir, 'openapi.json');
  await writeFile(path, JSON.stringify(spec));
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function fakeCtx(): ExtensionCommandContext {
  return {
    sandbox: {} as Sandbox,
    cwd: '/',
    env: {},
    stdin: '',
  };
}

function oneOpSpec(): unknown {
  return {
    openapi: '3.1.0',
    info: { title: 'test', version: '1.0.0' },
    servers: [{ url: API_HOST }],
    paths: {
      '/widgets': {
        post: {
          operationId: 'widgetCreate',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe('createOpenAPIExtension', () => {
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(async () => {
    nock.cleanAll();
    for (const fn of cleanups) await fn();
    cleanups = [];
  });

  it('dispatches a subcommand, posts to the upstream, and returns JSON on stdout', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const captured: Array<Record<string, unknown>> = [];
    nock(API_HOST)
      .post('/widgets', (body) => {
        captured.push(body as Record<string, unknown>);
        return true;
      })
      .reply(200, { id: 'w1' });

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(
      ['widgetCreate', '{"name":"foo"}'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ id: 'w1' }) + '\n');
    assert.deepEqual(captured, [{ name: 'foo' }]);
  });

  it('throws a clear error when the spec has no servers and no baseUrl is given', async () => {
    const spec = oneOpSpec() as Record<string, unknown>;
    delete spec.servers;

    const { path, cleanup } = await writeSpec(spec);
    cleanups.push(cleanup);

    await assert.rejects(
      createOpenAPIExtension({ name: 'api', openapi: path }),
      (err: Error) => {
        assert.match(err.message, /api/);
        assert.match(err.message, /no baseUrl/i);
        return true;
      },
    );
  });

  it('throws when the spec has no operations', async () => {
    const { path, cleanup } = await writeSpec({
      openapi: '3.1.0',
      info: { title: 't', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {},
    });
    cleanups.push(cleanup);

    await assert.rejects(
      createOpenAPIExtension({ name: 'api', openapi: path }),
      (err: Error) => {
        assert.match(err.message, /no operations/i);
        return true;
      },
    );
  });

  it('throws when two operations resolve to the same subcommand name', async () => {
    const { path, cleanup } = await writeSpec({
      openapi: '3.1.0',
      info: { title: 't', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets': {
          post: {
            operationId: 'collide',
            responses: { '200': { description: 'ok' } },
          },
        },
        '/gadgets': {
          post: {
            operationId: 'collide',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    cleanups.push(cleanup);

    await assert.rejects(
      createOpenAPIExtension({ name: 'api', openapi: path }),
      (err: Error) => {
        assert.match(err.message, /duplicate/i);
        assert.match(err.message, /collide/);
        assert.match(err.message, /\/widgets/);
        assert.match(err.message, /\/gadgets/);
        return true;
      },
    );
  });

  it('returns exit 1 with a descriptive stderr when the input is not valid JSON', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(
      ['widgetCreate', 'not-json{'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.group, 'api');
    assert.equal(parsed.operation, 'widgetCreate');
    assert.equal(parsed.code, 'invalid_json');
  });

  it('surfaces non-Error throws from the HTTP layer as stringified stderr', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
      fetch: async () => {
        throw 'upstream-blew-up';
      },
    });

    const result = await commands[0].handler(
      ['widgetCreate', '{"name":"foo"}'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.code, 'request_failed');
    assert.match(parsed.message, /upstream-blew-up/);
    assert.doesNotMatch(parsed.message, /\[object Object\]/);
  });

  it('returns exit 1 with Zod error text when the JSON fails schema validation', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(
      ['widgetCreate', '{"name":123}'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.code, 'schema_validation');
    assert.equal(parsed.group, 'api');
    assert.equal(parsed.operation, 'widgetCreate');
    assert.ok(Array.isArray(parsed.issues));
  });

  it('schema subcommand dumps every operation as JSON Schema', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'test', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets': {
          post: {
            operationId: 'widgetCreate',
            summary: 'Create a widget',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
          get: {
            operationId: 'widgetList',
            summary: 'List widgets',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const { path, cleanup } = await writeSpec(spec);
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(['schema'], fakeCtx());

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, '');

    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.group, 'api');
    assert.ok(Array.isArray(parsed.operations));
    assert.equal(parsed.operations.length, 2);

    const byId = new Map<string, Record<string, unknown>>();
    for (const op of parsed.operations) byId.set(op.operationId, op);

    const create = byId.get('widgetCreate');
    assert.ok(create, 'widgetCreate operation present');
    assert.equal(create!.method, 'POST');
    assert.equal(create!.path, '/widgets');
    assert.equal(create!.summary, 'Create a widget');
    assert.equal(typeof create!.input, 'object');

    const list = byId.get('widgetList');
    assert.ok(list, 'widgetList operation present');
    assert.equal(list!.method, 'GET');
    assert.equal(list!.path, '/widgets');
    assert.equal(list!.summary, 'List widgets');
  });

  it('rejects path-param values that contain disallowed characters', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'test', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets/{id}': {
          get: {
            operationId: 'getWidget',
            parameters: [
              {
                in: 'path',
                name: 'id',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const { path, cleanup } = await writeSpec(spec);
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(
      ['getWidget', '{"id":"a/b"}'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'path_param_unsafe');
    assert.equal(parsed.field, 'id');
    assert.match(parsed.message, /disallowed character/);
  });

  it('emits NDJSON when the upstream response data is a top-level array', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'test', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets': {
          get: {
            operationId: 'widgetList',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { id: { type: 'integer' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const { path, cleanup } = await writeSpec(spec);
    cleanups.push(cleanup);

    nock(API_HOST)
      .get('/widgets')
      .reply(200, [{ id: 1 }, { id: 2 }, { id: 3 }]);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(['widgetList', '{}'], fakeCtx());

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, '{"id":1}\n{"id":2}\n{"id":3}\n');
  });

  it('emits missing_input when no JSON arg is provided', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });

    const result = await commands[0].handler(['widgetCreate'], fakeCtx());

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, 'missing_input');
    assert.equal(parsed.group, 'api');
    assert.equal(parsed.operation, 'widgetCreate');
    assert.match(parsed.message, /no input provided/);
  });

  it('throws when an operationId equals the reserved name "schema"', async () => {
    const { path, cleanup } = await writeSpec({
      openapi: '3.1.0',
      info: { title: 't', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets/schema': {
          get: {
            operationId: 'schema',
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    cleanups.push(cleanup);

    await assert.rejects(
      createOpenAPIExtension({ name: 'api', openapi: path }),
      (err: Error) => {
        assert.match(err.message, /reserved/i);
        return true;
      },
    );
  });

  it('produces a consistent JSON envelope for every error code', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1.0.0' },
      servers: [{ url: API_HOST }],
      paths: {
        '/widgets/{id}': {
          get: {
            operationId: 'getWidget',
            parameters: [
              {
                in: 'path',
                name: 'id',
                required: true,
                schema: { type: 'string' },
              },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
        '/widgets': {
          post: {
            operationId: 'widgetCreate',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: { name: { type: 'string' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const { path, cleanup } = await writeSpec(spec);
    cleanups.push(cleanup);

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
      fetch: async () => {
        throw new Error('upstream-down');
      },
    });
    const handler = commands[0].handler;

    const cases: Array<{ code: string; args: string[]; operation: string }> = [
      {
        code: 'missing_input',
        args: ['widgetCreate'],
        operation: 'widgetCreate',
      },
      {
        code: 'invalid_json',
        args: ['widgetCreate', 'not-json'],
        operation: 'widgetCreate',
      },
      {
        code: 'schema_validation',
        args: ['widgetCreate', '{"name":123}'],
        operation: 'widgetCreate',
      },
      {
        code: 'path_param_unsafe',
        args: ['getWidget', '{"id":"a/b"}'],
        operation: 'getWidget',
      },
      {
        code: 'request_failed',
        args: ['widgetCreate', '{"name":"foo"}'],
        operation: 'widgetCreate',
      },
    ];

    for (const c of cases) {
      const result = await handler(c.args, fakeCtx());
      assert.equal(result.exitCode, 1, `case ${c.code}: expected exit 1`);
      assert.equal(result.stdout, '', `case ${c.code}: stdout must be empty`);
      const parsed = JSON.parse(result.stderr);
      assert.equal(parsed.ok, false, `case ${c.code}: ok=false`);
      assert.equal(parsed.group, 'api', `case ${c.code}: group=api`);
      assert.equal(parsed.operation, c.operation, `case ${c.code}: operation`);
      assert.equal(parsed.code, c.code, `case ${c.code}: code matches`);
      assert.equal(
        typeof parsed.message,
        'string',
        `case ${c.code}: message is string`,
      );
      assert.ok(parsed.message.length > 0, `case ${c.code}: message non-empty`);
    }
  });

  it('serializes the full error (including nested cause) into request_failed', async () => {
    const { path, cleanup } = await writeSpec(oneOpSpec());
    cleanups.push(cleanup);

    const innerCause = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:3000'),
      {
        code: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
        address: '127.0.0.1',
        port: 3000,
      },
    );
    const outer = new Error('fetch failed', { cause: innerCause });

    const { commands } = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
      fetch: async () => {
        throw outer;
      },
    });

    const result = await commands[0].handler(
      ['widgetCreate', '{"name":"foo"}'],
      fakeCtx(),
    );

    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.code, 'request_failed');
    assert.equal(parsed.message, 'fetch failed');

    assert.ok(parsed.error, 'extra.error present');
    assert.equal(parsed.error.message, 'fetch failed');
    assert.equal(parsed.error.name, 'Error');

    assert.ok(parsed.error.cause, 'nested cause serialized');
    assert.equal(
      parsed.error.cause.message,
      'connect ECONNREFUSED 127.0.0.1:3000',
    );
    assert.equal(parsed.error.cause.code, 'ECONNREFUSED');
    assert.equal(parsed.error.cause.errno, -61);
    assert.equal(parsed.error.cause.syscall, 'connect');
    assert.equal(parsed.error.cause.address, '127.0.0.1');
    assert.equal(parsed.error.cause.port, 3000);
  });
});
