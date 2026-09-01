import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
} from '@deepagents/context';
import { devtool } from '@deepagents/devtool';
import { fileTelemetry } from '@deepagents/devtool-traces';
import { tracesHttp } from '@deepagents/devtool-traces/http';
import {
  AgentRuntime,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

class AcceptingTurnQueue extends TurnQueue {
  push(_turn: TurnRef): Promise<void> {
    return Promise.resolve();
  }

  getTurnActivity(): Promise<TurnActivity> {
    return Promise.resolve('idle');
  }

  getCurrentTurn(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  consume(): Promise<AsyncDisposable> {
    return Promise.resolve({
      [Symbol.asyncDispose]: () => Promise.resolve(),
    });
  }

  resumeParked(): Promise<void> {
    return Promise.resolve();
  }
}

const DEVTOOL_PREFIX = '/devtool';
const USER_HEADER = 'x-test-user';
const ZUKHRUF_MOUNT_PATH = '/zukhruf/v1';
const CREATE_SESSION_URL = `${ZUKHRUF_MOUNT_PATH}/session`;
const HEALTH_URL = `${ZUKHRUF_MOUNT_PATH}/health`;
const HISTORY_URL = `${ZUKHRUF_MOUNT_PATH}/history`;
const INFO_URL = `${ZUKHRUF_MOUNT_PATH}/info`;

function telemetryRecords(
  conversation: { chatId: string; userId: string },
  streamId: string,
) {
  const zukhruf = {
    conversation,
    streamId,
    agentName: 'devtool-test',
    agentPath: '/root',
  };
  return [
    {
      event: 'onStart',
      timestamp: '2026-08-27T10:00:00.000Z',
      data: { callId: 'call-1', zukhruf, recordInputs: false },
    },
    {
      event: 'onEnd',
      timestamp: '2026-08-27T10:00:01.000Z',
      data: {
        callId: 'call-1',
        finishReason: 'stop',
        totalUsage: { inputTokens: 3, outputTokens: 2 },
      },
    },
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')
    .concat('\n');
}

test('one host server mounts Zukhruf and the DevTool UI on one origin', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'deepagents-devtool-'),
  );
  const telemetry = join(directory.path, 'telemetry.jsonl');
  const conversation = { chatId: 'chat-1', userId: 'user-1' };
  await using resources = new AsyncDisposableStack();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (value) => value.close(),
  );
  const mailboxStore = resources.use(new SqliteMailboxStore(':memory:'));
  const store = new InMemoryContextStore();
  const traceTelemetry = fileTelemetry({ path: telemetry, append: true });
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'devtool-test',
      model: { provider: 'test', modelId: 'test' } as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [traceTelemetry],
    }),
    {
      store,
      streams: new StreamManager({
        store: streamStore,
        changeSource: new PollingChangeSource({ reads: streamStore }),
      }),
      queue: new AcceptingTurnQueue(),
      mailboxStore,
    },
  );
  await runtime.createSession(conversation);
  await store.updateChat(conversation.chatId, () => ({
    title: 'First conversation',
  }));
  const turn = await runtime.enqueue(conversation, {
    message: {
      id: 'message-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    },
    trigger: 'submit-message',
  });
  await writeFile(telemetry, telemetryRecords(conversation, turn.id));
  resources.use(await runtime.work());

  const app = new Hono<HttpEnv>();
  app.use(`${ZUKHRUF_MOUNT_PATH}/*`, (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    return next();
  });
  app.route(ZUKHRUF_MOUNT_PATH, http(runtime, tracesHttp(traceTelemetry)));
  app.route(DEVTOOL_PREFIX, devtool());
  const asUser = { headers: { [USER_HEADER]: conversation.userId } };

  const health = await app.request(HEALTH_URL);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const discovery = await app.request(INFO_URL, asUser);
  assert.equal(discovery.status, 200);
  const discoveryBody = await discovery.text();
  assert.deepEqual(JSON.parse(discoveryBody), {
    ...runtime.info,
    capabilities: {
      history: { href: HISTORY_URL },
      chat: { href: CREATE_SESSION_URL },
      traces: { href: `${ZUKHRUF_MOUNT_PATH}/traces` },
    },
  });
  assert.doesNotMatch(discoveryBody, /file:|telemetry\.jsonl/);
  assert.equal((await app.request(INFO_URL)).status, 401);

  const history = await app.request(HISTORY_URL, asUser);
  assert.equal(history.status, 200);
  const [entry] = (await history.json()) as Array<Record<string, unknown>>;
  assert.equal(entry.chatId, conversation.chatId);
  assert.equal(entry.title, 'First conversation');

  const traceList = await app.request(
    `${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}`,
    asUser,
  );
  assert.equal(traceList.status, 200);
  const [trace] = (await traceList.json()) as Array<{
    id: string;
    streamId: string;
    status: string;
  }>;
  assert.deepEqual(
    { id: trace.id, streamId: trace.streamId, status: trace.status },
    { id: 'call-1', streamId: turn.id, status: 'queued' },
  );
  const traceDetail = await app.request(
    `${ZUKHRUF_MOUNT_PATH}/traces/${conversation.chatId}/${trace.id}`,
    asUser,
  );
  assert.equal(traceDetail.status, 200);
  const detail = (await traceDetail.json()) as {
    spans: Array<{ type: string }>;
  };
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

  for (const path of [DEVTOOL_PREFIX, `${DEVTOOL_PREFIX}/`]) {
    const shellResponse = await app.request(path);
    assert.equal(shellResponse.status, 200);
    assert.match(await shellResponse.text(), /<title>Zukhruf Devtool<\/title>/);
  }
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
  for (const deepLink of [
    `${DEVTOOL_PREFIX}/history`,
    `${DEVTOOL_PREFIX}/chat/${crypto.randomUUID()}`,
    `${DEVTOOL_PREFIX}/history/user-1/chat-1/traces/call-1`,
    `${DEVTOOL_PREFIX}/scheduled`,
  ]) {
    const deepLinkResponse = await app.request(deepLink);
    assert.equal(deepLinkResponse.status, 200);
    assert.match(
      await deepLinkResponse.text(),
      /<title>Zukhruf Devtool<\/title>/,
    );
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
