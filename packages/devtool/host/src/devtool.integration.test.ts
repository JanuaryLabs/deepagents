import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_SESSION_ID,
  ATTR_USER_ID,
} from '@opentelemetry/semantic-conventions/incubating';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { VirtualSandboxEnvironment } from '@deepagents/context';
import { devtool } from '@deepagents/devtool';
import { fileTelemetry, tracesHttp } from '@deepagents/devtool/traces';
import {
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

const DEVTOOL_PREFIX = '/devtool';
const USER_HEADER = 'x-test-user';
const ZUKHRUF_MOUNT_PATH = '/zukhruf/v1';
const CREATE_SESSION_URL = `${ZUKHRUF_MOUNT_PATH}/session`;
const HEALTH_URL = `${ZUKHRUF_MOUNT_PATH}/health`;
const HISTORY_URL = `${ZUKHRUF_MOUNT_PATH}/history`;
const INFO_URL = `${ZUKHRUF_MOUNT_PATH}/info`;
const TRACE_ID = '1'.repeat(32);

/** These turns never use the sandbox; the toolkit only needs a real one to start. */
const unusedSandbox = defineSandbox(new VirtualSandboxEnvironment());

function telemetryRecords(
  conversation: { chatId: string; userId: string },
  streamId: string,
) {
  return `${JSON.stringify({
    trace_id: TRACE_ID,
    span_id: '2'.repeat(16),
    parent_span_id: '',
    name: 'ai.streamText',
    kind: 'SPAN_KIND_INTERNAL',
    start_time: '2026-08-27T10:00:00.000000000Z',
    end_time: '2026-08-27T10:00:01.000000000Z',
    status: { code: 'STATUS_CODE_UNSET', message: '' },
    attributes: {
      [ATTR_SESSION_ID]: conversation.chatId,
      [ATTR_USER_ID]: conversation.userId,
      [ATTR_GEN_AI_AGENT_NAME]: 'devtool-test',
      [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent',
      [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: ['stop'],
      'deepagents.stream.id': streamId,
      'deepagents.agent.path': '/root',
      'deepagents.span.type': 'operation',
      'deepagents.record.inputs': false,
      'deepagents.record.outputs': true,
    },
    events: [],
  })}\n`;
}

test('one host server mounts Zukhruf and the DevTool UI on one origin', async () => {
  await using directory = await new TemporaryFiles().directory(
    'deepagents-devtool-',
  );
  const telemetry = join(directory.path, 'telemetry.jsonl');
  const conversation = { chatId: 'chat-1', userId: 'user-1' };
  await using storage = await EmbeddedAgentStorage.open({
    directory: join(directory.path, 'storage'),
  });
  const traceTelemetry = fileTelemetry({ path: telemetry });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'devtool-test',
      model: new MockLanguageModelV4({ provider: 'test', modelId: 'test' }),
      sandbox: unusedSandbox,
      instructions: [],
      plugins: [traceTelemetry],
    }),
  );
  const stack = defineStack(async () => ({ storage }));
  await using host = await runtime.initialize(stack);
  await host.createSession(conversation);
  await storage.store.updateChat(conversation.chatId, () => ({
    title: 'First conversation',
  }));
  const turn = await host.enqueue(conversation, {
    message: {
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    },
    trigger: 'submit-message',
  });
  await writeFile(telemetry, telemetryRecords(conversation, turn.id));

  const app = new Hono<HttpEnv>();
  app.use(`${ZUKHRUF_MOUNT_PATH}/*`, (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    return next();
  });
  app.route(ZUKHRUF_MOUNT_PATH, http(host, tracesHttp(traceTelemetry)));
  app.route(DEVTOOL_PREFIX, devtool());
  const asUser = { headers: { [USER_HEADER]: conversation.userId } };

  const health = await app.request(HEALTH_URL);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const discovery = await app.request(INFO_URL, asUser);
  assert.equal(discovery.status, 200);
  const discoveryBody = await discovery.text();
  assert.deepEqual(JSON.parse(discoveryBody), {
    ...host.info,
    capabilities: {
      history: { href: HISTORY_URL },
      chat: { href: CREATE_SESSION_URL },
      events: { href: `${ZUKHRUF_MOUNT_PATH}/events` },
      traces: { href: `${ZUKHRUF_MOUNT_PATH}/traces` },
    },
  });
  assert.doesNotMatch(discoveryBody, /file:|telemetry\.jsonl/);
  assert.equal((await app.request(INFO_URL)).status, 401);

  const history = await app.request(HISTORY_URL, asUser);
  assert.equal(history.status, 200);
  const [entry] = z
    .array(z.record(z.string(), z.unknown()))
    .parse(await history.json());
  assert.equal(entry.chatId, conversation.chatId);
  assert.equal(entry.title, 'First conversation');
  // No worker runs, since the mock model has no stream to answer with: the turn waits in the queue, so its conversation is active.
  assert.deepEqual(entry.status, { type: 'active', activeFlags: [] });

  const traceList = await app.request(
    `${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}`,
    asUser,
  );
  assert.equal(traceList.status, 200);
  const [trace] = z
    .array(
      z.object({ id: z.string(), streamId: z.string(), status: z.string() }),
    )
    .parse(await traceList.json());
  assert.deepEqual(
    { id: trace.id, streamId: trace.streamId, status: trace.status },
    { id: TRACE_ID, streamId: turn.id, status: 'queued' },
  );
  const traceDetail = await app.request(
    `${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}/${trace.id}`,
    asUser,
  );
  assert.equal(traceDetail.status, 200);
  const detail = z
    .object({ spans: z.array(z.object({ type: z.string() })) })
    .parse(await traceDetail.json());
  assert.deepEqual(
    detail.spans.map(({ type }) => type),
    ['agent'],
  );
  assert.equal(
    (
      await app.request(
        `${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}?userId=${conversation.userId}`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request(`${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}`, {
        headers: { [USER_HEADER]: 'other-user' },
      })
    ).status,
    404,
  );

  const shell = await (await app.request(DEVTOOL_PREFIX)).text();
  assert.match(shell, new RegExp(`<base href="${DEVTOOL_PREFIX}/"`));
  const assets = Array.from(
    shell.matchAll(/(?:src|href)="([^"]+)"/g),
    ([, asset]) => asset,
  ).filter((asset) => asset.startsWith('./assets/'));
  assert(assets.length > 0);
  for (const asset of assets) {
    const path = new URL(asset, `http://localhost${DEVTOOL_PREFIX}/`).pathname;
    assert.match(path, new RegExp(`^${DEVTOOL_PREFIX}/assets/`));
    const assetResponse = await app.request(path);
    assert.equal(assetResponse.status, 200);
    assert((await assetResponse.arrayBuffer()).byteLength > 0);
  }
  for (const path of [
    `${DEVTOOL_PREFIX}/assets/missing.js`,
    `${ZUKHRUF_MOUNT_PATH}/missing`,
    '/devtoolx',
    '/',
  ]) {
    assert.equal((await app.request(path, asUser)).status, 404);
  }
});

void test.each([DEVTOOL_PREFIX, `${DEVTOOL_PREFIX}/`], (path) =>
  test(`devtool serves its shell at ${path}`, async () => {
    const app = new Hono().route(DEVTOOL_PREFIX, devtool());

    const shellResponse = await app.request(path);

    assert.equal(shellResponse.status, 200);
    assert.match(await shellResponse.text(), /<title>Zukhruf Devtool<\/title>/);
  }),
);

void test.each(
  [
    { page: 'history', path: `${DEVTOOL_PREFIX}/history` },
    { page: 'a chat', path: `${DEVTOOL_PREFIX}/chat/${crypto.randomUUID()}` },
    {
      page: 'a trace',
      path: `${DEVTOOL_PREFIX}/history/user-1/chat-1/traces/call-1`,
    },
    { page: 'scheduled', path: `${DEVTOOL_PREFIX}/scheduled` },
  ],
  ({ page, path }) =>
    test(`devtool answers the deep link to ${page} with its shell`, async () => {
      const app = new Hono().route(DEVTOOL_PREFIX, devtool());

      const deepLinkResponse = await app.request(path);

      assert.equal(deepLinkResponse.status, 200);
      assert.match(
        await deepLinkResponse.text(),
        /<title>Zukhruf Devtool<\/title>/,
      );
    }),
);

test('devtool follows the host-selected UI and protocol mounts', async () => {
  const mount = '/host/selected/devtool';
  const protocolPath = '/host/selected/zukhruf';
  const app = new Hono().route(mount, devtool({ protocolPath }));
  const shell = await (await app.request(`${mount}/history/user-1`)).text();

  assert.match(shell, new RegExp(`<base href="${mount}/"`));
  assert.match(
    shell,
    new RegExp(
      `<meta\\s+name="deepagents-zukhruf-info"\\s+content="${protocolPath}/info"`,
    ),
  );
  const asset = shell.match(/(?:src|href)="(\.\/assets\/[^"]+)"/);
  assert(asset);
  const response = await app.request(`${mount}/${asset[1].slice(2)}`);
  assert.equal(response.status, 200);
  assert((await response.arrayBuffer()).byteLength > 0);
  assert.throws(
    () => devtool({ protocolPath: '//example.com/zukhruf' }),
    /same-origin absolute path/,
  );
});
