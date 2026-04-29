import { InMemoryFs } from 'just-bash';
import nock from 'nock';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createBashTool,
  createOpenAPIExtension,
  createRoutingSandbox,
  createVirtualSandbox,
} from '@deepagents/context';

const API_HOST = 'https://api.example.test';

async function writeSpec(
  spec: unknown,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'openapi-extension-sandbox-'));
  const path = join(dir, 'openapi.json');
  await writeFile(path, JSON.stringify(spec));
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function listSpec(): unknown {
  return {
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
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
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

describe('createOpenAPIExtension (sandbox dispatch)', () => {
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(async () => {
    nock.cleanAll();
    for (const fn of cleanups) await fn();
    cleanups = [];
  });

  it('dispatches an operation through `cd "/" && api widgetList` via the install path', async () => {
    nock(API_HOST)
      .get('/widgets')
      .reply(200, [{ id: 'a' }, { id: 'b' }]);

    const { path, cleanup } = await writeSpec(listSpec());
    cleanups.push(cleanup);

    const extension = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const routed = await createRoutingSandbox({
      backend,
      hostExtensions: [extension],
    });
    const sandbox = await createBashTool({ sandbox: routed, destination: '/' });

    const result = (await sandbox.tools.bash.execute!(
      { command: "api widgetList '{}'", reasoning: 'sandbox dispatch test' },
      {} as never,
    )) as { stdout: string; stderr: string; exitCode: number };

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /"id":"a"/);
    assert.match(result.stdout, /"id":"b"/);
  });

  it('auto-repairs over-quoted JSON via onBeforeBashCall before dispatch', async () => {
    nock(API_HOST).post('/widgets').reply(200, { id: 'created' });

    const { path, cleanup } = await writeSpec(listSpec());
    cleanups.push(cleanup);

    const extension = await createOpenAPIExtension({
      name: 'api',
      openapi: path,
    });
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const routed = await createRoutingSandbox({
      backend,
      hostExtensions: [extension],
    });

    const broken = 'api widgetCreate \'{"name":"foo"}';
    const result = await routed.executeCommand(broken);

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, JSON.stringify({ id: 'created' }) + '\n');
  });
});
