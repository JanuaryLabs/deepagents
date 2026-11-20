import { TemporaryFiles } from '@zukhruf/fs';
import spawn from 'nano-spawn';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import {
  type AdmissionScope,
  AdmissionScopeError,
  EmbeddedAgentStorage,
  InterAgentCommunicationTypes,
  type TurnRef,
  createInterAgentCommunication,
} from '@deepagents/experimental/zukhruf';

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
    signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
  });

  await storage.admit({ userId: 'user-1', treeId: 'root' }, (scope) =>
    scope.queue.push(turn),
  );
  const [reported] = await warning;
  // The storage closes its queue database itself, which is already closed.
  await assert.rejects(storage[Symbol.asyncDispose](), /PGlite is closed/);
  await using reopened = await EmbeddedAgentStorage.open({
    directory: directory.path,
  });

  assert.deepStrictEqual(
    {
      reported: String(reported),
      // A turn the reopened storage never pushes would wait for the whole test timeout.
      deliveries: await deliveries(
        reopened,
        turn,
        AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
      ),
    },
    {
      reported: 'Error: PGlite is closed',
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
    signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
  });

  // Platform setup no storage operation exposes: the database closes under
  // pg-boss, whose own polling then fails.
  await storage.queueDatabase.close();
  const [reported] = await warning;
  // The storage closes its queue database itself, which is already closed.
  await assert.rejects(storage[Symbol.asyncDispose](), /PGlite is closed/);

  assert.equal(String(reported), 'Error: PGlite is closed');
});
