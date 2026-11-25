import { serve } from '@hono/node-server';
import { TemporaryFiles } from '@zukhruf/fs';
import { Postgres } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Server } from 'node:http';
import test from 'node:test';
import { PgBoss } from 'pg-boss';

import { VirtualSandboxEnvironment } from '@deepagents/context';
import {
  AgentRuntime,
  type AgentStorage,
  EmbeddedAgentStorage,
  PgBossConversationStatusChangeSource,
  PostgresAgentStorage,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

const MOUNT = '/zukhruf/v1';
const READY = 'data: {"type":"ready"}\n\n';

const testPostgres = new Postgres({ environment: process.env });

const storages = [
  {
    name: 'embedded',
    open: async (resources: AsyncDisposableStack) => {
      const directory = resources.use(
        await new TemporaryFiles().directory('zukhruf-'),
      );
      const storage = resources.use(
        await EmbeddedAgentStorage.open({ directory: directory.path }),
      );
      return { storage, boss: storage.boss };
    },
  },
  {
    name: 'postgres',
    open: async (resources: AsyncDisposableStack) => {
      const database = resources.use(await testPostgres.database());
      const boss = new PgBoss({ connectionString: database.connectionString });
      boss.on('error', () => {});
      await boss.start();
      resources.defer(() => boss.stop({ graceful: false }));
      const storage = resources.use(
        await PostgresAgentStorage.create({
          pool: database.pool(),
          boss,
          queue: { pollingIntervalSeconds: 0.5 },
        }),
      );
      return { storage, boss };
    },
  },
] satisfies {
  name: string;
  open(
    resources: AsyncDisposableStack,
  ): Promise<{ storage: AgentStorage; boss: PgBoss }>;
}[];

/** How many database listeners the boss holds open right now. */
function countListeners(boss: PgBoss) {
  const db = boss.getDb();
  assert.ok(db.listen, 'the storage database supports LISTEN');
  const listen = db.listen.bind(db);
  const listeners = { open: 0 };
  db.listen = async (...args) => {
    const handle = await listen(...args);
    listeners.open += 1;
    return {
      async close() {
        await handle.close();
        listeners.open -= 1;
      },
    };
  };
  return listeners;
}

/** Reads the stream to its end and returns what it carried. */
async function readToEnd(reader: ReadableStreamDefaultReader<string>) {
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

for (const { name, open } of storages) {
  for (const crossProcess of [false, true]) {
    const statusChanges = crossProcess ? 'cross-process' : 'in-process';
    test(`${name}, ${statusChanges} status: disposing the runtime ends an open GET /events stream and every later one, and the server's close then completes`, async (t) => {
      await using resources = new AsyncDisposableStack();
      const { storage, boss } = await open(resources);
      const listeners = countListeners(boss);
      const runtime = resources.use(
        await new AgentRuntime(
          defineAgent({
            name: 'assistant',
            instructions: [],
            model: new MockLanguageModelV4(),
            sandbox: defineSandbox(new VirtualSandboxEnvironment()),
          }),
        ).initialize(
          defineStack(async () => ({
            storage,
            ...(crossProcess
              ? {
                  conversationStatusChanges:
                    new PgBossConversationStatusChangeSource(boss),
                }
              : {}),
          })),
        ),
      );
      const app = new Hono<HttpEnv>();
      app.use(`${MOUNT}/*`, (context, next) => {
        context.set('userId', 'user-1');
        return next();
      });
      app.route(MOUNT, http(runtime));
      const server = serve({
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: 0,
      });
      assert.ok(server instanceof Server);
      resources.defer(() => {
        server.closeAllConnections();
        if (server.listening) server.close();
      });
      await once(server, 'listening', { signal: t.signal });
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      const events = `http://127.0.0.1:${address.port}${MOUNT}/events`;

      const response = await fetch(events, { signal: t.signal });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      assert.deepEqual(await reader.read(), { done: false, value: READY });
      assert.equal(listeners.open, crossProcess ? 1 : 0);

      await runtime[Symbol.asyncDispose]();

      assert.equal(listeners.open, 0);
      assert.equal(await readToEnd(reader), '');
      const late = await fetch(events, { signal: t.signal });
      assert.equal(late.status, 200);
      assert.equal(await late.text(), READY);
      const closed = Promise.withResolvers<void>();
      server.close((error) =>
        error ? closed.reject(error) : closed.resolve(),
      );
      await closed.promise;
    });
  }
}
