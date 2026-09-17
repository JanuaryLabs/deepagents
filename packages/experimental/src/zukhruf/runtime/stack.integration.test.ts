import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  PollingChangeSource,
  SqliteContextStore,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentPluginCapability,
  type AgentPluginDefinition,
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import { type HttpEnv, http } from '@deepagents/experimental/zukhruf/http';

const model = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: 'hello from the stack' },
        { type: 'text-end', id: 'answer' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});
const root = defineAgent({
  name: 'stack-test',
  model,
  instructions: [],
  sandbox: defineSandbox(() => createVirtualSandbox({ fs: new InMemoryFs() })),
});

async function adapters(resources: AsyncDisposableStack) {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const streamStore = new SqliteStreamStore(
    resources.use(new DatabaseSync(':memory:')),
  );
  return {
    store: new SqliteContextStore(resources.use(new DatabaseSync(':memory:'))),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

const conversation = { chatId: 'stack-chat', userId: 'user' };

test('one setup creates independent ready hosts with plugins, HTTP, and queued turns', async () => {
  let opens = 0;
  const value = new AgentPluginCapability<number>('test.instance');
  const plugin: AgentPluginDefinition<{
    instance: number;
    initialized: boolean;
  }> = {
    name: 'bound',
    capabilities: [value],
    create: (bindings) => {
      let initialized = false;
      return {
        instance: bindings.get(value),
        get initialized() {
          return initialized;
        },
        async initialize() {
          await Promise.resolve();
          initialized = true;
        },
      };
    },
  };
  const stack = defineStack(async (resources) => {
    const instance = ++opens;
    return { ...(await adapters(resources)), bindings: [value.bind(instance)] };
  });
  const setup = new AgentRuntime(defineAgent({ ...root, plugins: [plugin] }));
  assert.equal(opens, 0);
  assert.equal('enqueue' in setup, false);
  assert.equal('observe' in setup, false);
  assert.equal('work' in setup, false);
  assert.equal(Symbol.asyncDispose in setup, false);

  await using hosts = new AsyncDisposableStack();
  const [host, second] = await Promise.all([
    setup.initialize(stack).then((host) => hosts.use(host)),
    setup.initialize(stack).then((host) => hosts.use(host)),
  ]);
  assert.equal(opens, 2);
  assert.notEqual(host, second);
  assert.equal(host.plugin(plugin).instance, 1);
  assert.equal(second.plugin(plugin).instance, 2);
  assert.equal(host.plugin(plugin).initialized, true);
  assert.equal(second.plugin(plugin).initialized, true);
  assert.equal(host.info.root, root.name);

  const app = new Hono<HttpEnv>();
  app.use((context, next) => {
    context.set('userId', 'user');
    return next();
  });
  app.route('/', http(host));
  const info = await app.request('/info');
  assert.equal(info.status, 200);
  assert.partialDeepStrictEqual(await info.json(), { root: root.name });

  const turn = await host.enqueue(conversation, {
    message: {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: 'hello' }],
    },
    trigger: 'submit-message',
  });
  assert.equal(
    (await host.observe(conversation).status(turn.id))?.status,
    'queued',
  );
  await host.work();
  const chunks = [];
  for await (const chunk of turn.stream) chunks.push(chunk);
  assert.equal(
    chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join(''),
    'hello from the stack',
  );
  assert.equal(
    (await host.observe(conversation).status(turn.id))?.status,
    'completed',
  );
  assert.equal((await host.listHistory('user')).length, 1);
  assert.equal(await second.sessionExists(conversation), false);
});

test('stack failure rolls back in reverse order and does not poison the setup', async () => {
  const closed: string[] = [];
  const startupError = new Error('stack failed');
  const cleanupError = new Error('cleanup failed');
  const setup = new AgentRuntime(root);
  const stack = defineStack(async (resources) => {
    resources.defer(() => {
      closed.push('first');
    });
    resources.defer(() => {
      closed.push('second');
      throw cleanupError;
    });
    throw startupError;
  });
  const failed = await setup.initialize(stack).catch((error: unknown) => error);
  assert.ok(failed instanceof SuppressedError);
  assert.equal(failed.error, cleanupError);
  assert.equal(failed.suppressed, startupError);
  assert.deepEqual(closed, ['second', 'first']);
  await assert.rejects(setup.initialize(stack), SuppressedError);
  assert.deepEqual(closed, ['second', 'first', 'second', 'first']);
  const validStack = defineStack(adapters);
  await using host = await setup.initialize(validStack);
  assert.equal(host.info.root, root.name);
});

test('plugin initialization failure closes contributions before stack resources', async () => {
  const closed: string[] = [];
  const first: AgentPluginDefinition = {
    name: 'first',
    create: () => ({
      initialize: async () => ({
        [Symbol.asyncDispose]: async () => {
          closed.push('plugin');
        },
      }),
    }),
  };
  const failing: AgentPluginDefinition = {
    name: 'failing',
    create: () => ({
      initialize: async () => {
        throw new Error('plugin failed');
      },
    }),
  };
  const setup = new AgentRuntime(
    defineAgent({ ...root, plugins: [first, failing] }),
  );
  const stack = defineStack(async (resources) => {
    resources.defer(() => {
      closed.push('stack');
    });
    return adapters(resources);
  });
  await assert.rejects(setup.initialize(stack), /plugin failed/);
  assert.deepEqual(closed, ['plugin', 'stack']);
});

test('a ready host waits for worker startup, then closes workers before plugins and data', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const workerEntered = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const closed: string[] = [];
  const plugin: AgentPluginDefinition = {
    name: 'lifetime',
    create: () => ({
      initialize: async () => ({
        [Symbol.asyncDispose]: async () => {
          closed.push('plugin');
        },
      }),
      work: async (_host, waitForActive) => {
        assert.equal(waitForActive, true);
        workerEntered.resolve();
        await releaseWorker.promise;
        return {
          [Symbol.asyncDispose]: async () => {
            closed.push('worker');
          },
        };
      },
    }),
  };
  const setup = new AgentRuntime(defineAgent({ ...root, plugins: [plugin] }));
  const stack = defineStack(async (resources) => {
    resources.defer(() => {
      closed.push('stack');
    });
    entered.resolve();
    await release.promise;
    return adapters(resources);
  });
  const opening = setup.initialize(stack);
  await entered.promise;
  assert.deepEqual(closed, []);
  release.resolve();
  await using host = await opening;
  const working = host.work();
  await workerEntered.promise;
  const disposing = host[Symbol.asyncDispose]();
  assert.deepEqual(closed, []);
  releaseWorker.resolve();
  const worker = await working;
  await disposing;
  assert.deepEqual(closed, ['worker', 'plugin', 'stack']);
  await worker[Symbol.asyncDispose]();
  assert.deepEqual(closed, ['worker', 'plugin', 'stack']);
  assert.throws(() => host.work(), ReferenceError);
});

test('borrowed adapters survive their initialized host', async () => {
  const setup = new AgentRuntime(root);
  await using resources = new AsyncDisposableStack();
  const options = await adapters(resources);
  const stack = defineStack(async () => options);
  const host = await setup.initialize(stack);
  assert.equal(host.info.root, root.name);
  await host.createSession(conversation);
  await host[Symbol.asyncDispose]();
  assert.equal(
    (await options.store.getChat(conversation.chatId))?.userId,
    conversation.userId,
  );
  await using reopened = await setup.initialize(stack);
  assert.equal(await reopened.sessionExists(conversation), true);
});

for (const ownership of ['owned', 'borrowed']) {
  test(`a host with ${ownership} adapters drains an active turn before closing resources`, async () => {
    await using sharedResources = new AsyncDisposableStack();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    let options: Awaited<ReturnType<typeof adapters>> | undefined;
    const plugin: AgentPluginDefinition = {
      name: 'cleanup',
      create: () => ({
        initialize: async () => ({
          [Symbol.asyncDispose]: async () => {
            assert.ok(options);
            assert.equal(
              await options.queue.getTurnActivity(conversation),
              'idle',
            );
            assert.equal(
              (await options.store.getChat(conversation.chatId))?.userId,
              conversation.userId,
            );
            events.push('plugin closed');
          },
        }),
      }),
    };
    const setup = new AgentRuntime(
      defineAgent({
        ...root,
        model: new MockLanguageModelV4({
          doStream: async (options) => {
            entered.resolve();
            await release.promise;
            events.push('model completed');
            return model.doStream(options);
          },
        }),
        plugins: [plugin],
      }),
    );
    const stack = defineStack(async (resources) => {
      resources.defer(() => {
        events.push('stack closed');
      });
      options = await adapters(
        ownership === 'owned' ? resources : sharedResources,
      );
      return options;
    });
    const host = await setup.initialize(stack);
    let disposing: Promise<void> | undefined;
    try {
      await host.work();
      const turn = await host.enqueue(conversation, {
        message: {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: 'wait for me' }],
        },
        trigger: 'submit-message',
      });
      await turn.stream.cancel();
      await entered.promise;
      disposing = host[Symbol.asyncDispose]();
      const { setImmediate } = await import('node:timers/promises');
      await setImmediate();
      assert.deepEqual(events, []);
      release.resolve();
      await disposing;
      assert.deepEqual(events, [
        'model completed',
        'plugin closed',
        'stack closed',
      ]);
      assert.ok(options);
      if (ownership === 'borrowed') {
        assert.equal(
          (await options.store.getChat(conversation.chatId))?.userId,
          conversation.userId,
        );
        assert.equal(
          (await options.streams.store.getStream(turn.id))?.status,
          'completed',
        );
        assert.equal(
          await options.mailboxStore.hasPending(conversation),
          false,
        );
        assert.equal(await options.queue.getTurnActivity(conversation), 'idle');
      } else {
        await assert.rejects(
          options.store.getChat(conversation.chatId),
          /not open/,
        );
        await assert.rejects(
          options.streams.store.getStream(turn.id),
          /finalized/,
        );
        await assert.rejects(
          options.mailboxStore.hasPending(conversation),
          /not open/,
        );
        await assert.rejects(
          options.queue.getTurnActivity(conversation),
          /closed/,
        );
      }
    } finally {
      release.resolve();
      await disposing;
      await host[Symbol.asyncDispose]();
    }
  });
}
