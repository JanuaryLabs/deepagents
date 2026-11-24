import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { Postgres, type PostgresDatabase } from '@zukhruf/testing/postgres';
import { MockLanguageModelV4 } from 'ai/test';
import { Hono } from 'hono';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

import {
  DockerSandboxEnvironment,
  type SandboxEnvironment,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  type AgentHost,
  AgentRuntime,
  type AgentStorage,
  EmbeddedAgentStorage,
  MessageDeliveryModes,
  PostgresAgentStorage,
  createInterAgentCommunication,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';
import {
  type HttpEnv,
  type HttpProjection,
  http,
} from '@deepagents/experimental/zukhruf/http';
import { uploads } from '@deepagents/experimental/zukhruf/uploads';
import {
  UPLOAD_FILENAME_HEADER,
  uploadsHttp,
} from '@deepagents/experimental/zukhruf/uploads/http';

import {
  textResult,
  toolCallResult,
} from '../../../testing/stream-results.fixture.ts';

const MOUNT = '/zukhruf/v1';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = await testbed.defaults();
const testPostgres = new Postgres({ environment: process.env });

const acceptedBodySchema = z.looseObject({ turnId: z.string() });
const historySchema = z.array(
  z.looseObject({
    chatId: z.string(),
    status: z.looseObject({ type: z.string() }),
    children: z.array(
      z.looseObject({
        chatId: z.string(),
        path: z.string(),
        state: z.string(),
      }),
    ),
  }),
);

/** One host process's storage on the database, with its own pool and pg-boss. */
async function postgresStorage(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
) {
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
}

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
    open: async (resources: AsyncDisposableStack) =>
      postgresStorage(resources, resources.use(await testPostgres.database())),
  },
] satisfies {
  name: string;
  open(
    resources: AsyncDisposableStack,
  ): Promise<{ storage: AgentStorage; boss: PgBoss }>;
}[];

/** A runtime of the root agent `name` on `storage`, served as http(runtime, ...projections) behind a user header. */
async function serveAgent(
  resources: AsyncDisposableStack,
  storage: AgentStorage,
  agent: Pick<
    AgentDeclaration,
    'name' | 'model' | 'sandbox' | 'subagents' | 'plugins'
  >,
  ...projections: HttpProjection[]
) {
  const runtime = resources.use(
    await new AgentRuntime(
      defineAgent({ instructions: [], ...agent }),
    ).initialize(defineStack(async () => ({ storage }))),
  );
  const app = new Hono<HttpEnv>();
  app.use(`${MOUNT}/*`, (context, next) => {
    context.set('userId', context.req.header('x-user-id') ?? 'user-1');
    return next();
  });
  app.route(MOUNT, http(runtime, ...projections));
  return { app, runtime };
}

function postTurn(app: Hono<HttpEnv>, sessionId: string) {
  return app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      message: {
        id: `message-${randomUUID()}`,
        role: 'user',
        parts: [{ type: 'text', text: 'Hello' }],
      },
      trigger: 'submit-message',
    }),
  });
}

async function startTurn(app: Hono<HttpEnv>, sessionId: string) {
  const response = await postTurn(app, sessionId);
  assert.equal(response.status, 202);
  return acceptedBodySchema.parse(await response.json()).turnId;
}

/** Starts the session with a turn, once that turn has completed. */
async function completedTurn(
  { app, runtime }: { app: Hono<HttpEnv>; runtime: AgentHost },
  sessionId: string,
  signal: AbortSignal,
) {
  const turnId = await startTurn(app, sessionId);
  await waitFor(
    async () =>
      assert.equal(
        (
          await runtime
            .observe({ chatId: sessionId, userId: 'user-1' })
            .status(turnId)
        )?.status,
        'completed',
      ),
    { signal },
  );
}

function deleteSession(
  app: Hono<HttpEnv>,
  sessionId: string,
  userId = 'user-1',
) {
  return app.request(`${MOUNT}/session/${sessionId}`, {
    method: 'DELETE',
    headers: { 'x-user-id': userId },
  });
}

async function answer(response: Response) {
  const text = await response.text();
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: text === '' ? null : JSON.parse(text),
  };
}

function sessionNotFound(sessionId: string) {
  return {
    status: 404,
    cacheControl: 'no-store',
    body: {
      error: 'Session not found',
      cause: {
        code: 'zukhruf/session-not-found',
        detail: `Session ${sessionId} does not exist`,
      },
    },
  };
}

const deleted = { status: 204, cacheControl: 'no-store', body: null };

/** The containers of the namespace, or of one chat in it, found by their labels. */
async function namespaceContainers(namespace: string, chatId?: string) {
  const client = await testbed.client();
  return client.containers.list({
    all: true,
    filters: {
      label: [
        `deepagents.sandbox.namespace=${namespace}`,
        ...(chatId === undefined ? [] : [`deepagents.sandbox.chat=${chatId}`]),
      ],
    },
  });
}

/** Removes every container of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  const client = await testbed.client();
  for (const { Id } of await namespaceContainers(namespace)) {
    if (Id === undefined) continue;
    await (await client.containers.find(Id))?.remove({ force: true });
  }
}

/** The file the root's turn wrote, read through a handle of its own that opens the chat's sandbox. */
async function readKept(
  environment: SandboxEnvironment,
  chat: { chatId: string; userId: string },
) {
  await using sandbox = await environment.open(chat);
  const read = await sandbox.run({ command: 'cat /tmp/kept.txt' });
  return read.exitCode === 0 ? read.stdout : 'gone';
}

/** The root's tool call that spawns the worker sub-agent at /root/worker. */
function spawnWorker() {
  return toolCallResult({
    toolCallId: randomUUID(),
    toolName: 'spawn_agent',
    input: JSON.stringify({
      task_name: 'worker',
      agent_type: 'worker',
      message: 'start',
      fork_turns: 'none',
    }),
  });
}

function worker(sandbox: AgentDeclaration['sandbox']) {
  return defineAgent({
    name: 'worker',
    instructions: [],
    sandbox,
    model: new MockLanguageModelV4({
      doStream: async () => textResult('worker done'),
    }),
  });
}

/** The worker's conversation, once the session and its worker are idle with nothing queued. */
function idleChild(
  app: Hono<HttpEnv>,
  storage: AgentStorage,
  sessionId: string,
  signal: AbortSignal,
) {
  const root = { chatId: sessionId, userId: 'user-1' };
  return waitFor(
    async () => {
      const history = historySchema.parse(
        await (await app.request(`${MOUNT}/history`)).json(),
      );
      const session = history.find(({ chatId }) => chatId === sessionId);
      const found = session?.children.find(
        ({ path }) => path === '/root/worker',
      );
      assert.deepStrictEqual(
        { session: session?.status.type, worker: found?.state },
        { session: 'idle', worker: 'completed' },
      );
      assert.ok(found);
      const child = { chatId: found.chatId, userId: 'user-1' };
      for (const member of [root, child]) {
        assert.equal(await storage.queue.getTurnActivity(member), 'idle');
      }
      return child;
    },
    { signal },
  );
}

for (const { name, open } of storages) {
  test(`${name}: DELETE /session/:sessionId answers 404 for an unknown session, another user's session, another runtime's root and a deleted session, and leaves the session to its owner until its owner deletes it`, async (t) => {
    await using resources = new AsyncDisposableStack();
    const { storage } = await open(resources);
    const sandbox = defineSandbox(new VirtualSandboxEnvironment());
    const model = () =>
      new MockLanguageModelV4({ doStream: async () => textResult('done') });
    const owner = await serveAgent(resources, storage, {
      name: 'owner',
      model: model(),
      sandbox,
    });
    const other = await serveAgent(resources, storage, {
      name: 'other',
      model: model(),
      sandbox,
    });
    resources.use(await owner.runtime.work());
    const sessionId = randomUUID();
    const unknownId = randomUUID();
    await completedTurn(owner, sessionId, t.signal);
    const ownerSession = async () =>
      (await owner.app.request(`${MOUNT}/session/${sessionId}`)).status;

    const unknown = await answer(await deleteSession(owner.app, unknownId));
    const otherUser = await answer(
      await deleteSession(owner.app, sessionId, 'user-2'),
    );
    const otherRuntime = await answer(
      await deleteSession(other.app, sessionId),
    );
    const keptForOwner = await ownerSession();
    const first = await answer(await deleteSession(owner.app, sessionId));
    const second = await answer(await deleteSession(owner.app, sessionId));

    assert.deepStrictEqual(
      { unknown, otherUser, otherRuntime, keptForOwner, first, second },
      {
        unknown: sessionNotFound(unknownId),
        otherUser: sessionNotFound(sessionId),
        otherRuntime: sessionNotFound(sessionId),
        keptForOwner: 200,
        first: deleted,
        second: sessionNotFound(sessionId),
      },
    );
  });

  test(`${name}: DELETE /session/:sessionId of a session whose turn spawned a sub-agent, with mail and a turn queued for the sub-agent, removes the root and the sub-agent: their chats, streams, mail, queued turns and containers`, async (t) => {
    const namespace = `delete-${randomUUID()}`;
    try {
      await using resources = new AsyncDisposableStack();
      const { storage } = await open(resources);
      const environment = new DockerSandboxEnvironment({
        namespace,
        container: defaults,
      });
      const sandbox = defineSandbox(environment, { idleTimeoutMs: false });
      const rootSteps = [
        toolCallResult({
          toolCallId: randomUUID(),
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo kept > /tmp/kept.txt',
            reasoning: 'leave a file in the chat sandbox',
          }),
        }),
        spawnWorker(),
      ];
      const { app, runtime } = await serveAgent(resources, storage, {
        name: 'root',
        model: new MockLanguageModelV4({
          doStream: async () => rootSteps.shift() ?? textResult('done'),
        }),
        sandbox,
        subagents: [worker(sandbox)],
      });
      const workers = await runtime.work({ concurrency: 2 });
      const sessionId = randomUUID();
      const root = { chatId: sessionId, userId: 'user-1' };
      const turnId = await startTurn(app, sessionId);
      const child = await idleChild(app, storage, sessionId, t.signal);
      // With no worker left, the mail's turn stays queued.
      await workers[Symbol.asyncDispose]();
      await runtime.deliver(
        createInterAgentCommunication({
          author: root,
          recipient: child,
          content: 'run again',
        }),
        MessageDeliveryModes.TriggerTurn,
      );
      const streamIds = await storage.streams.store.listStreamIds();
      const fileBefore = await readKept(environment, root);
      const before = {
        file: fileBefore,
        rootTurn: streamIds.includes(turnId),
        // A turn id names its conversation's namespace second.
        conversationsWithStreams: new Set(
          streamIds.map((id) => id.split(':')[1]),
        ).size,
        childMail: await storage.mailboxStore.hasPending(child),
        childActivity: await storage.queue.getTurnActivity(child),
        containers: (await namespaceContainers(namespace)).length,
      };

      const response = await answer(await deleteSession(app, sessionId));

      const containers = (await namespaceContainers(namespace)).length;
      const history = historySchema.parse(
        await (await app.request(`${MOUNT}/history`)).json(),
      );
      assert.deepStrictEqual(
        {
          before,
          response,
          session: await answer(
            await app.request(`${MOUNT}/session/${sessionId}`),
          ),
          history: history.map(({ chatId }) => chatId),
          chats: {
            root: await storage.store.getChat(root.chatId),
            child: await storage.store.getChat(child.chatId),
          },
          streams: await Promise.all(
            streamIds.map((id) => storage.streams.store.getStream(id)),
          ),
          childMail: await storage.mailboxStore.hasPending(child),
          activity: {
            root: await storage.queue.getTurnActivity(root),
            child: await storage.queue.getTurnActivity(child),
          },
          containers,
          fileAfterReopen: await readKept(environment, root),
        },
        {
          before: {
            file: 'kept\n',
            rootTurn: true,
            conversationsWithStreams: 2,
            childMail: true,
            childActivity: 'queued',
            containers: 2,
          },
          response: deleted,
          session: sessionNotFound(sessionId),
          history: [],
          chats: { root: undefined, child: undefined },
          streams: streamIds.map(() => undefined),
          childMail: false,
          activity: { root: 'idle', child: 'idle' },
          containers: 0,
          fileAfterReopen: 'gone',
        },
      );
    } finally {
      await removeNamespace(namespace);
    }
  });

  test(`${name}: a DELETE cut short by a failing sandbox delete leaves the session absent and admitting nothing, and a second DELETE finishes it`, async (t) => {
    await using resources = new AsyncDisposableStack();
    const { storage } = await open(resources);
    const virtual = new VirtualSandboxEnvironment();
    const deletes: string[] = [];
    let backendDown = true;
    const environment: SandboxEnvironment = {
      open: (chat) => virtual.open(chat),
      delete: async (chat) => {
        deletes.push(chat.chatId);
        if (backendDown) {
          backendDown = false;
          throw new Error('the sandbox backend is down');
        }
        await virtual.delete(chat);
      },
    };
    const sandbox = defineSandbox(environment);
    const rootSteps = [spawnWorker()];
    const { app, runtime } = await serveAgent(resources, storage, {
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => rootSteps.shift() ?? textResult('done'),
      }),
      sandbox,
      subagents: [worker(sandbox)],
    });
    resources.use(await runtime.work({ concurrency: 2 }));
    const sessionId = randomUUID();
    const root = { chatId: sessionId, userId: 'user-1' };
    await startTurn(app, sessionId);
    const child = await idleChild(app, storage, sessionId, t.signal);
    const refusal = async (operation: Promise<unknown>) =>
      operation.then(
        () => 'admitted',
        (error: unknown) => (Error.isError(error) ? error.name : 'rejected'),
      );

    const cutShort = (await deleteSession(app, sessionId)).status;
    const meanwhile = {
      session: await answer(await app.request(`${MOUNT}/session/${sessionId}`)),
      history: historySchema
        .parse(await (await app.request(`${MOUNT}/history`)).json())
        .map(({ chatId }) => chatId),
      createSession: await refusal(runtime.createSession(root)),
      rootTurn: await refusal(
        runtime.enqueue(root, {
          message: {
            id: randomUUID(),
            role: 'user',
            parts: [{ type: 'text', text: 'again' }],
          },
          trigger: 'submit-message',
        }),
      ),
      childMail: await refusal(
        runtime.deliver(
          createInterAgentCommunication({
            author: root,
            recipient: child,
            content: 'run again',
          }),
          MessageDeliveryModes.TriggerTurn,
        ),
      ),
      rowsKept: {
        root: (await storage.store.getChat(root.chatId)) !== undefined,
        child: (await storage.store.getChat(child.chatId)) !== undefined,
      },
    };
    const retried = await answer(await deleteSession(app, sessionId));

    assert.deepStrictEqual(
      {
        cutShort,
        meanwhile,
        retried,
        deletes,
        chats: {
          root: await storage.store.getChat(root.chatId),
          child: await storage.store.getChat(child.chatId),
        },
      },
      {
        cutShort: 500,
        meanwhile: {
          session: sessionNotFound(sessionId),
          history: [],
          createSession: 'ConversationNotFoundError',
          rootTurn: 'ConversationNotFoundError',
          childMail: 'ConversationNotFoundError',
          rowsKept: { root: true, child: true },
        },
        retried: deleted,
        deletes: [child.chatId, child.chatId, root.chatId],
        chats: { root: undefined, child: undefined },
      },
    );
  });

  test(`${name}: a turn still running when its session is deleted fails on the deleted rows, and settling it as an orphan does not make the deleted session an agent again`, async (t) => {
    await using resources = new AsyncDisposableStack();
    const { storage, boss } = await open(resources);
    const released = Promise.withResolvers<void>();
    const { app, runtime } = await serveAgent(resources, storage, {
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => {
          await released.promise;
          return textResult('too late');
        },
      }),
      sandbox: defineSandbox(new VirtualSandboxEnvironment()),
    });
    resources.use(await runtime.work());
    const sessionId = randomUUID();
    const root = { chatId: sessionId, userId: 'user-1' };
    const turnId = await startTurn(app, sessionId);
    await waitFor(
      async () =>
        assert.equal(
          (await runtime.observe(root).status(turnId))?.status,
          'running',
        ),
      { signal: t.signal },
    );

    const response = await answer(await deleteSession(app, sessionId));
    released.resolve();
    // The dead-letter job completes only after the orphan is settled.
    const settled = await waitFor(
      async () => {
        const turns = await boss.findJobs('zukhruf-turns', { key: sessionId });
        const dead = await boss.findJobs<{ chatId: string }>(
          'zukhruf-turns-dead',
        );
        const orphans = dead
          .filter(({ data }) => data.chatId === sessionId)
          .map(({ state }) => state);
        assert.deepStrictEqual(
          { turns: turns.length, orphans },
          { turns: 0, orphans: ['completed'] },
        );
        return orphans;
      },
      { signal: t.signal },
    );

    assert.deepStrictEqual(
      {
        settled,
        response,
        // The turn's own writes can leave a bare chat row behind, which
        // stopping live work first (#5135 step 4) removes; the orphan must
        // not make it an agent again.
        agentMetadata: (await storage.store.getChat(root.chatId))?.metadata,
        history: historySchema
          .parse(await (await app.request(`${MOUNT}/history`)).json())
          .map(({ chatId }) => chatId),
        session: await answer(
          await app.request(`${MOUNT}/session/${sessionId}`),
        ),
      },
      {
        settled: ['completed'],
        response: deleted,
        agentMetadata: undefined,
        history: [],
        session: sessionNotFound(sessionId),
      },
    );
  });
}

const UPLOADS = '/workspace/uploads';
const PNG_PIXEL = Uint8Array.fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
);
const receiptSchema = z.looseObject({ url: z.string() });

/** One host process on the database, with its own pool, pg-boss and held sandboxes, serving the root agent and its uploads over HTTP. */
async function uploadsHost(
  resources: AsyncDisposableStack,
  database: PostgresDatabase,
  sandbox: AgentDeclaration['sandbox'],
) {
  const { storage } = await postgresStorage(resources, database);
  const uploaded = uploads({ directory: UPLOADS });
  return serveAgent(
    resources,
    storage,
    {
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => textResult('done'),
      }),
      sandbox,
      plugins: [uploaded],
    },
    uploadsHttp(uploaded, { maxBytes: 4096 }),
  );
}

function upload(app: Hono<HttpEnv>, sessionId: string) {
  return app.request(`${MOUNT}/session/${sessionId}/uploads`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      [UPLOAD_FILENAME_HEADER]: 'pixel.png',
    },
    body: PNG_PIXEL,
  });
}

test("postgres: a host still holding the sandbox handle of a session another host deleted answers 404 to the session's next upload and opens no container for it", async (t) => {
  const namespace = `stale-${randomUUID()}`;
  try {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    // Two host processes on one database, each with its own pool, pg-boss,
    // environment and held sandboxes.
    const host = () =>
      uploadsHost(
        resources,
        database,
        defineSandbox(
          new DockerSandboxEnvironment({ namespace, container: defaults }),
          { idleTimeoutMs: false },
        ),
      );
    const a = await host();
    const b = await host();
    resources.use(await a.runtime.work());
    const sessionId = randomUUID();
    await completedTurn(a, sessionId, t.signal);
    // B's upload opens the session's container, so B holds a handle to it.
    const held = (await upload(b.app, sessionId)).status;
    const before = (await namespaceContainers(namespace, sessionId)).length;

    const response = await answer(await deleteSession(a.app, sessionId));
    const stale = await answer(await upload(b.app, sessionId));

    assert.deepStrictEqual(
      {
        held,
        before,
        response,
        stale,
        containers: (await namespaceContainers(namespace, sessionId)).length,
      },
      {
        held: 201,
        before: 1,
        response: deleted,
        stale: sessionNotFound(sessionId),
        containers: 0,
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

test("postgres: while a DELETE cut short after removing the session's container leaves the session being deleted, an upload and a read of an uploaded file answer 404 on a host that still holds the session's sandbox handle, an upload answers 404 on the deleting host, which holds none, a turn answers 404, and no container is opened for the session; a second DELETE finishes the delete", async (t) => {
  const namespace = `cut-short-${randomUUID()}`;
  try {
    await using resources = new AsyncDisposableStack();
    const database = resources.use(await testPostgres.database());
    const docker = new DockerSandboxEnvironment({
      namespace,
      container: defaults,
    });
    let engineFails = true;
    const failingAfterRemoval: SandboxEnvironment = {
      open: (chat) => docker.open(chat),
      delete: async (chat) => {
        await docker.delete(chat);
        if (engineFails) {
          engineFails = false;
          throw new Error('the engine failed after removing the container');
        }
      },
    };
    const a = await uploadsHost(
      resources,
      database,
      defineSandbox(failingAfterRemoval),
    );
    const b = await uploadsHost(
      resources,
      database,
      defineSandbox(
        new DockerSandboxEnvironment({ namespace, container: defaults }),
        { idleTimeoutMs: false },
      ),
    );
    resources.use(await a.runtime.work());
    const sessionId = randomUUID();
    await completedTurn(a, sessionId, t.signal);
    const uploaded = await upload(b.app, sessionId);
    const held = uploaded.status;
    const { url } = receiptSchema.parse(await uploaded.json());
    const before = (await namespaceContainers(namespace, sessionId)).length;

    const cutShort = (await deleteSession(a.app, sessionId)).status;
    const meanwhile = {
      heldUpload: await answer(await upload(b.app, sessionId)),
      heldRead: await answer(await b.app.request(url)),
      deletingHostUpload: await answer(await upload(a.app, sessionId)),
      turn: await answer(await postTurn(b.app, sessionId)),
      containers: (await namespaceContainers(namespace, sessionId)).length,
    };
    const retried = await answer(await deleteSession(a.app, sessionId));

    assert.deepStrictEqual(
      {
        held,
        before,
        cutShort,
        meanwhile,
        retried,
        containers: (await namespaceContainers(namespace, sessionId)).length,
      },
      {
        held: 201,
        before: 1,
        cutShort: 500,
        meanwhile: {
          heldUpload: sessionNotFound(sessionId),
          heldRead: sessionNotFound(sessionId),
          deletingHostUpload: sessionNotFound(sessionId),
          turn: sessionNotFound(sessionId),
          containers: 0,
        },
        retried: deleted,
        containers: 0,
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});
