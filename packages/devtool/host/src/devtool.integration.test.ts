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
import {
  AgentRuntime,
  SqliteMailboxStore,
  type TurnActivity,
  type TurnPushResult,
  TurnQueue,
  type TurnRef,
  ZUKHRUF_CREATE_SESSION_ROUTE_PATH,
  ZUKHRUF_HEALTH_ROUTE_PATH,
  ZUKHRUF_HISTORY_ROUTE_PATH,
  ZUKHRUF_INFO_ROUTE_PATH,
  ZUKHRUF_ROUTE_PREFIX,
  defineAgent,
  zukhruf,
} from '@deepagents/experimental/zukhruf';

class AcceptingTurnQueue extends TurnQueue {
  push(turn: TurnRef): Promise<TurnPushResult> {
    return Promise.resolve({ jobId: turn.streamId, inserted: true });
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
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'devtool-test',
      model: { provider: 'test', modelId: 'test' } as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      plugins: [fileTelemetry({ path: telemetry, append: true })],
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
    id: 'message-1',
    input: 'Hello',
  });
  await writeFile(telemetry, telemetryRecords(conversation, turn.id));
  resources.use(await runtime.work());

  const app = new Hono<{ Variables: { userId: string } }>();
  app.use(`${ZUKHRUF_ROUTE_PREFIX}/*`, async (context, next) => {
    const userId = context.req.header(USER_HEADER);
    if (userId) context.set('userId', userId);
    await next();
  });
  app.route(ZUKHRUF_ROUTE_PREFIX, zukhruf(runtime));
  app.route(DEVTOOL_PREFIX, devtool());
  const asUser = { headers: { [USER_HEADER]: conversation.userId } };

  const health = await app.request(ZUKHRUF_HEALTH_ROUTE_PATH);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const discovery = await app.request(ZUKHRUF_INFO_ROUTE_PATH, asUser);
  assert.equal(discovery.status, 200);
  const discoveryBody = await discovery.text();
  assert.deepEqual(JSON.parse(discoveryBody), {
    ...runtime.info,
    capabilities: {
      history: { href: ZUKHRUF_HISTORY_ROUTE_PATH },
      chat: { href: ZUKHRUF_CREATE_SESSION_ROUTE_PATH },
      traces: { href: `${ZUKHRUF_ROUTE_PREFIX}/traces` },
    },
  });
  assert.doesNotMatch(discoveryBody, /file:|telemetry\.jsonl/);
  assert.equal((await app.request(ZUKHRUF_INFO_ROUTE_PATH)).status, 401);

  const history = await app.request(ZUKHRUF_HISTORY_ROUTE_PATH, asUser);
  assert.equal(history.status, 200);
  const [entry] = (await history.json()) as Array<Record<string, unknown>>;
  assert.equal(entry.chatId, conversation.chatId);
  assert.equal(entry.title, 'First conversation');

  const traceList = await app.request(
    `${ZUKHRUF_ROUTE_PREFIX}/traces/${conversation.chatId}`,
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
    `${ZUKHRUF_ROUTE_PREFIX}/traces/${conversation.chatId}/${trace.id}`,
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
        `${ZUKHRUF_ROUTE_PREFIX}/traces/${conversation.chatId}?userId=${conversation.userId}`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await app.request(
        `${ZUKHRUF_ROUTE_PREFIX}/traces/${conversation.chatId}`,
        {
          headers: { [USER_HEADER]: 'other-user' },
        },
      )
    ).status,
    404,
  );

  for (const path of [DEVTOOL_PREFIX, `${DEVTOOL_PREFIX}/`]) {
    const shellResponse = await app.request(path);
    assert.equal(shellResponse.status, 200);
    assert.match(await shellResponse.text(), /<title>Zukhruf Devtool<\/title>/);
  }
  const shell = await (await app.request(DEVTOOL_PREFIX)).text();
  const assets = Array.from(
    shell.matchAll(/(?:src|href)="([^"]+)"/g),
    ([, asset]) => asset,
  ).filter((asset) => asset.startsWith('/'));
  assert(assets.length > 0);
  for (const asset of assets) {
    assert.match(asset, new RegExp(`^${DEVTOOL_PREFIX}/assets/`));
    const assetResponse = await app.request(asset);
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
    `${ZUKHRUF_ROUTE_PREFIX}/missing`,
    '/devtoolx',
    '/',
  ]) {
    assert.equal((await app.request(path, asUser)).status, 404);
  }
});
