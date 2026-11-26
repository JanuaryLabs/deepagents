import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';
import { MockLanguageModelV4 } from 'ai/test';
import spawn from 'nano-spawn';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type AdmissionScope,
  AdmissionScopeError,
  AgentRuntime,
  EmbeddedAgentStorage,
  InterAgentCommunicationTypes,
  type SandboxIdleWake,
  type TurnRef,
  type Wake,
  createInterAgentCommunication,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { textResult } from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const fixture = join(import.meta.dirname, 'embedded-crash.fixture.ts');

/** A turn with every part a TurnRef carries, so a delivery shows what the outbox kept. */
function childTurn(chatId: string): TurnRef {
  return {
    kind: 'message',
    streamId: `turn/${chatId}#1`,
    chatId,
    userId: 'user-1',
    message: {
      id: `${chatId}-task`,
      role: 'user',
      parts: [{ type: 'text', text: 'new task' }],
    },
    trigger: 'submit-message',
    elements: [],
  };
}

/** Writes a child chat, its stream, a trigger-turn mail and its turn through every bound part. */
async function admitChild(scope: AdmissionScope, chatId: string) {
  await scope.store.createChat({ id: chatId, userId: 'user-1' });
  await scope.mailboxStore.enqueue({
    ...createInterAgentCommunication({
      author: { chatId: 'root', userId: 'user-1' },
      recipient: { chatId, userId: 'user-1' },
      content: 'new task',
      type: InterAgentCommunicationTypes.NewTask,
    }),
    triggerTurn: true,
  });
  await scope.queue.push(childTurn(chatId));
  await scope.streams.createStream({
    id: `turn/${chatId}#1`,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    error: null,
  });
}

/** What the storage's own parts read of `admitChild`'s four writes. */
async function admitted(storage: EmbeddedAgentStorage, chatId: string) {
  const conversation = { chatId, userId: 'user-1' };
  return {
    chat: (await storage.store.getChat(chatId))?.userId,
    stream: await storage.streams.store.getStreamStatus(`turn/${chatId}#1`),
    mail: await storage.mailboxStore.hasPendingTriggerTurn(conversation),
    turn: await storage.queue.getTurnActivity(conversation),
  };
}

const NOTHING = {
  chat: undefined,
  stream: undefined,
  mail: false,
  turn: 'idle',
};
const EVERYTHING = {
  chat: 'user-1',
  stream: 'queued',
  mail: true,
  turn: 'queued',
};

/** The warning the storage in `directory` emits when its background queue work fails with `failure`. */
const storageWarning = (directory: string, failure: string) => ({
  name: 'EmbeddedStorageWarning',
  code: 'DEEPAGENTS_ZUKHRUF_EMBEDDED_STORAGE_FAILED',
  detail: `directory: ${directory}`,
  message: `The embedded storage's background queue work failed with no caller left to take it: ${failure}`,
});

/**
 * Consumes `storage`'s turns until `streamId` has settled, then reads the
 * conversation's activity: a second job of the turn would still be queued.
 */
async function deliveries(
  storage: EmbeddedAgentStorage,
  turn: TurnRef,
  signal: AbortSignal,
) {
  const delivered: TurnRef[] = [];
  const settled = Promise.withResolvers<void>();
  await using _consumer = await storage.queue.consume(
    async (claimed) => {
      delivered.push(claimed);
    },
    {
      onOrphaned: async (orphan, error) => {
        settled.reject(new Error(`${orphan.streamId} orphaned: ${error}`));
      },
      onSettled: async (done) => {
        if (done.streamId === turn.streamId) settled.resolve();
      },
    },
  );
  signal.addEventListener('abort', () => settled.reject(signal.reason));
  await settled.promise;
  return {
    delivered,
    afterwards: await storage.queue.getTurnActivity(turn),
  };
}

/** Runs the crash fixture on `directory` until it prints `stop`, then SIGKILLs it. */
async function crashAt(directory: string, stop: string, signal: AbortSignal) {
  const subprocess = spawn(process.execPath, [fixture, directory, stop], {
    stdin: 'ignore',
  });
  const completed = Promise.allSettled([subprocess]);
  const child = await subprocess.nodeChildProcess;
  try {
    assert.ok(child.stdout);
    using lines = createInterface({ input: child.stdout, signal });
    for await (const line of lines) {
      if (line === stop) return;
    }
    const [result] = await completed;
    assert.fail(
      `fixture ended before "${stop}": ${String(result.status === 'rejected' ? result.reason : '')}`,
    );
  } finally {
    child.kill('SIGKILL');
    await completed;
  }
}

test('an admission whose work throws leaves none of its chat, stream, mail and turn; one that resolves commits all four', async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const tree = { userId: 'user-1', treeId: 'root' };

  const refusal = storage.admit(tree, async (scope) => {
    await admitChild(scope, 'refused');
    throw new Error('admission refused');
  });
  await assert.rejects(refusal, /admission refused/);
  const accepted = await storage.admit(tree, async (scope) => {
    await admitChild(scope, 'accepted');
    return 'accepted';
  });

  assert.deepStrictEqual(
    {
      accepted,
      refused: await admitted(storage, 'refused'),
      admitted: await admitted(storage, 'accepted'),
    },
    { accepted: 'accepted', refused: NOTHING, admitted: EVERYTHING },
  );
});

test('a write through the storage while an admission is open waits for it and survives its rollback', async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let seenInside: string | undefined;

  const refusal = storage.admit(
    { userId: 'user-1', treeId: 'root' },
    async (scope) => {
      await admitChild(scope, 'refused');
      entered.resolve();
      await release.promise;
      // node:sqlite writes when called, so a write that reached the connection is visible here.
      seenInside = (await scope.store.getChat('outside'))?.userId;
      throw new Error('admission refused');
    },
  );
  await entered.promise;
  const outside = storage.store.createChat({ id: 'outside', userId: 'user-1' });
  release.resolve();
  await assert.rejects(refusal, /admission refused/);
  await outside;

  assert.deepStrictEqual(
    {
      seenInside,
      outside: (await storage.store.getChat('outside'))?.userId,
      refused: await admitted(storage, 'refused'),
    },
    { seenInside: undefined, outside: 'user-1', refused: NOTHING },
  );
});

test("an admission's work that calls the storage itself fails with AdmissionScopeError instead of waiting for itself", async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const tree = { userId: 'user-1', treeId: 'root' };

  const throughStorage = storage.admit(tree, async (scope) => {
    await scope.store.createChat({ id: 'child', userId: 'user-1' });
    await storage.store.getChat('child');
  });
  const nested = storage.admit(tree, () =>
    storage.admit(tree, async () => 'inner'),
  );

  await assert.rejects(throughStorage, AdmissionScopeError);
  await assert.rejects(nested, AdmissionScopeError);
  assert.equal(await storage.store.getChat('child'), undefined);
});

test('a turn an admission pushed reaches a worker once, as does a turn pushed outside an admission', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const admittedTurn = childTurn('admitted');
  const pushedTurn = childTurn('pushed');

  // Each turn is delivered before the next push, so only its own relay trigger can move it.
  await storage.admit({ userId: 'user-1', treeId: 'root' }, (scope) =>
    scope.queue.push(admittedTurn),
  );
  const admitted = await deliveries(storage, admittedTurn, t.signal);
  await storage.queue.push(pushedTurn);
  const pushed = await deliveries(storage, pushedTurn, t.signal);

  assert.deepStrictEqual(
    { admitted, pushed },
    {
      admitted: { delivered: [admittedTurn], afterwards: 'idle' },
      pushed: { delivered: [pushedTurn], afterwards: 'idle' },
    },
  );
});

test('inside an admission a child whose turn waits in the outbox counts as queued', async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const child = { chatId: 'child', userId: 'user-1' };

  const activity = await storage.admit(
    { userId: 'user-1', treeId: 'root' },
    async (scope) => {
      const before = await scope.queue.getTurnActivity(child);
      await scope.queue.push(childTurn('child'));
      return { before, after: await scope.queue.getTurnActivity(child) };
    },
  );

  assert.deepStrictEqual(activity, { before: 'idle', after: 'queued' });
});

test('admissions run one at a time, of one tree or of two: the next starts after the last commits and sees its writes', async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const events: string[] = [];

  const holding = storage.admit(
    { userId: 'user-1', treeId: 'root' },
    async (scope) => {
      await scope.store.createChat({ id: 'first-child', userId: 'user-1' });
      events.push('first entered');
      entered.resolve();
      await release.promise;
      events.push('first done');
    },
  );
  await entered.promise;
  const sameTree = storage.admit(
    { userId: 'user-1', treeId: 'root' },
    async (scope) => {
      events.push('same tree entered');
      return (await scope.store.getChat('first-child'))?.userId;
    },
  );
  const otherTree = storage.admit(
    { userId: 'user-1', treeId: 'other' },
    async () => {
      events.push('other tree entered');
    },
  );
  // Both wait for the connection before the first admission is released.
  release.resolve();
  await holding;
  const seenBySameTree = await sameTree;
  await otherTree;

  assert.deepStrictEqual(
    { events, seenBySameTree },
    {
      events: [
        'first entered',
        'first done',
        'same tree entered',
        'other tree entered',
      ],
      seenBySameTree: 'user-1',
    },
  );
});

test('a process killed after an admission committed and before the relay pushed its turn: reopening pushes it, and it runs once', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await crashAt(directory.path, 'committed', t.signal);

  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  assert.deepStrictEqual(
    await deliveries(storage, childTurn('child'), t.signal),
    {
      delivered: [childTurn('child')],
      afterwards: 'idle',
    },
  );
});

test('a process killed after the relay pushed a turn and before it deleted the outbox row: reopening pushes the same job again, and the turn runs once', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await crashAt(directory.path, 'pushed', t.signal);

  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  assert.deepStrictEqual(
    await deliveries(storage, childTurn('child'), t.signal),
    {
      delivered: [childTurn('child')],
      afterwards: 'idle',
    },
  );
});

/** What an `EmbeddedAgentStorage.open` of `directory` in another process ends with: `opened`, or its error. */
async function openFromAnotherProcess(directory: string) {
  const { stdout } = await spawn(
    process.execPath,
    [fixture, directory, 'open'],
    {
      stdin: 'ignore',
    },
  );
  return stdout;
}

test('a second process cannot open a directory the storage has open, and opens it once the storage is disposed', async () => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  const storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  let whileOpen: string;
  try {
    whileOpen = await openFromAnotherProcess(directory.path);
  } finally {
    await storage[Symbol.asyncDispose]();
  }
  const afterDispose = await openFromAnotherProcess(directory.path);

  assert.deepStrictEqual(
    { whileOpen, afterDispose },
    {
      whileOpen: `EmbeddedAgentStorageInUseError: EmbeddedAgentStorage: ${JSON.stringify(directory.path)} is open in another EmbeddedAgentStorage; one storage at a time may open a directory`,
      afterDispose: 'opened',
    },
  );
});

test('a process killed while it holds the storage open leaves the directory free to open', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await crashAt(directory.path, 'opened', t.signal);

  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  assert.equal(await storage.store.getChat('child'), undefined);
});

test("a turn whose push fails because the queue's database is gone is reported as a warning, kept, and delivered once by the next open", async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  const storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const turn = childTurn('child');
  // Platform setup no storage operation exposes: pg-boss stops, so only the
  // relay reaches its database, and the database closes under it.
  await storage.boss.stop({ graceful: false });
  await storage.queueDatabase.close();
  const warning = once(process, 'warning', {
    signal: t.signal,
  });

  await storage.admit({ userId: 'user-1', treeId: 'root' }, (scope) =>
    scope.queue.push(turn),
  );
  const [reported] = await warning;
  assert.ok(Error.isError(reported));
  // The storage closes its queue database itself, which is already closed.
  await assert.rejects(storage[Symbol.asyncDispose](), /PGlite is closed/);
  await using reopened = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  assert.deepStrictEqual(
    {
      reported: { ...reported, message: reported.message },
      // A turn the reopened storage never pushes would wait for the whole test timeout.
      deliveries: await deliveries(reopened, turn, t.signal),
    },
    {
      reported: storageWarning(directory.path, 'PGlite is closed'),
      deliveries: { delivered: [turn], afterwards: 'idle' },
    },
  );
});

test("a failure of the queue's pg-boss with no caller to take it is reported as a warning", async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  const storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const warning = once(process, 'warning', {
    signal: t.signal,
  });

  // Platform setup no storage operation exposes: the database closes under
  // pg-boss, whose own polling then fails.
  await storage.queueDatabase.close();
  const [reported] = await warning;
  assert.ok(Error.isError(reported));
  // The storage closes its queue database itself, which is already closed.
  await assert.rejects(storage[Symbol.asyncDispose](), /PGlite is closed/);

  assert.deepStrictEqual(
    { ...reported, message: reported.message },
    storageWarning(directory.path, 'PGlite is closed'),
  );
});

test('a sandbox idle wake scheduled before the storage closed waits on the queue named after the turn queue and reaches a consumer after it reopens', async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  const runAt = new Date();
  const wake: Wake<SandboxIdleWake> = {
    id: crypto.randomUUID(),
    runAt,
    data: {
      conversation: { chatId: 'child', userId: 'user-1' },
      turnId: 'turn/child#1',
      scheduledFor: runAt.getTime(),
    },
  };
  {
    await using closed = await EmbeddedAgentStorage.open({
      directory: directory.path,
      queue: { queue: 'tree-a' },
    });
    await closed.sandboxIdleWakes.schedule(wake);
  }

  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
    queue: { queue: 'tree-a' },
  });
  const waiting = await storage.boss.findJobs('tree-a-sandbox-idle', {
    id: wake.id,
  });
  const delivered = Promise.withResolvers<Wake<SandboxIdleWake>>();
  t.signal.addEventListener('abort', () => delivered.reject(t.signal.reason));
  await using _consumer = await storage.sandboxIdleWakes.consume(
    async (received) => delivered.resolve(received),
  );

  assert.deepStrictEqual(
    {
      waiting: waiting.map((job) => job.data),
      delivered: await delivered.promise,
    },
    { waiting: [wake.data], delivered: wake },
  );
});

const LOST_TURN_ERROR = 'turn lost: its queue job was deleted before it ran';

/** A host on `storage` whose model answers every turn and counts its calls in `model`. */
function countingHost(storage: EmbeddedAgentStorage, model: { calls: number }) {
  return new AgentRuntime(
    defineAgent({
      name: 'root',
      model: new MockLanguageModelV4({
        doStream: async () => {
          model.calls++;
          return textResult('done');
        },
      }),
      sandbox: buildSandbox(),
      instructions: [],
      plugins: [],
    }),
  ).initialize(defineStack(async () => ({ storage })));
}

/**
 * Waits for the turn queue's job of `streamId`, then past its retention, and
 * runs pg-boss maintenance, which deletes it. Maintenance runs again only
 * after pg-boss's maintenance interval, hours by default, so it runs once.
 */
async function retentionDeletes(
  storage: EmbeddedAgentStorage,
  streamId: string,
  signal: AbortSignal,
) {
  const job = await waitFor(
    async () => {
      const [found] = await storage.boss.findJobs('zukhruf-turns', {
        data: { streamId },
      });
      assert.ok(found);
      return found;
    },
    { interval: 20, signal },
  );
  await delay(job.keepUntil.getTime() - Date.now() + 100, undefined, {
    signal,
  });
  await storage.boss.supervise('zukhruf-turns');
  assert.deepStrictEqual(
    await storage.boss.findJobs('zukhruf-turns', { data: { streamId } }),
    [],
  );
}

test("a worker's startup sweep keeps a queued turn whose outbox row the relay has not deleted, though retention deleted its job, and reopening runs it once", async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  const turn = childTurn('child');
  const model = { calls: 0 };
  let afterSweep: string | undefined;
  {
    await using storage = await EmbeddedAgentStorage.open({
      directory: directory.path,
    });
    await using host = await countingHost(storage, model);
    await storage.boss.updateQueue('zukhruf-turns', { retentionSeconds: 1 });
    // Platform setup no storage operation exposes, as embedded-crash.fixture.ts
    // does at `pushed`: an open PGlite transaction holds the relay's push
    // until a second connection holds SQLite's write lock, so the relay pushes
    // the job and then, after its connection's busy timeout, fails to delete
    // its outbox row. Reopening would push the row before any worker starts,
    // so only a live storage shows the sweep a turn the outbox still holds.
    const queueHeld = Promise.withResolvers<void>();
    const queueReleased = Promise.withResolvers<void>();
    void storage.queueDatabase.transaction(async () => {
      queueHeld.resolve();
      await queueReleased.promise;
    });
    await queueHeld.promise;
    await storage.admit({ userId: 'user-1', treeId: 'root' }, async (scope) => {
      await scope.store.createChat({ id: turn.chatId, userId: 'user-1' });
      await scope.queue.push(turn);
      await scope.streams.createStream({
        id: turn.streamId,
        status: 'queued',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        error: null,
      });
    });
    {
      using writer = open(join(directory.path, 'zukhruf.sqlite'), {
        timeout: 0,
      });
      writer.exec('BEGIN IMMEDIATE');
      const warning = once(process, 'warning', { signal: t.signal });
      queueReleased.resolve();
      const [refused] = await warning;
      assert.ok(Error.isError(refused));
      assert.equal(
        refused.message,
        storageWarning(directory.path, 'database is locked').message,
      );
    }
    await retentionDeletes(storage, turn.streamId, t.signal);

    await using _worker = await host.work();
    afterSweep = await storage.streams.store.getStreamStatus(turn.streamId);
  }
  await using reopened = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  await using restarted = await countingHost(reopened, model);
  await using _worker = await restarted.work();
  await waitFor(
    async () =>
      assert.equal(
        await reopened.streams.store.getStreamStatus(turn.streamId),
        'completed',
      ),
    { signal: t.signal },
  );

  assert.deepStrictEqual(
    {
      afterSweep,
      calls: model.calls,
      afterwards: await reopened.queue.getTurnActivity(turn),
    },
    { afterSweep: 'queued', calls: 1, afterwards: 'idle' },
  );
});

test("a worker's startup sweep fails a turn the relay pushed whose job retention deleted, so its watch() stream ends with the lost-turn error", async (t) => {
  await using directory = await new TemporaryFiles().directory(
    'embedded-storage-',
  );
  await using storage = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });
  const model = { calls: 0 };
  await using host = await countingHost(storage, model);
  await storage.boss.updateQueue('zukhruf-turns', { retentionSeconds: 1 });

  const queued = await host.enqueue(
    { chatId: 'lost', userId: 'user-1' },
    userTurn('t-1', 'lost me'),
  );
  await retentionDeletes(storage, queued.id, t.signal);
  await using _worker = await host.work();

  assert.deepStrictEqual(
    {
      chunks: await untilAborted(Array.fromAsync(queued.stream), t.signal),
      calls: model.calls,
    },
    {
      chunks: [{ type: 'error', errorText: LOST_TURN_ERROR }],
      calls: 0,
    },
  );
});
