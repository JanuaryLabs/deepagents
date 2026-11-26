import { Backoff, untilAborted } from '@zukhruf/async';
import { retryUntilReady, waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';
import { StreamHarness } from '@zukhruf/testing/streams';
import { type UIMessageChunk, simulateReadableStream } from 'ai';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import type pg from 'pg';

import {
  PollingChangeSource,
  PostgresStreamStore,
  type StreamChunkData,
  type StreamData,
  StreamManager,
} from '@deepagents/context';

const POSTGRES_18 = { image: 'postgres:18-alpine' };

const testPostgres = new Postgres({ ...POSTGRES_18, environment: process.env });
const streamHarness = new StreamHarness();

function testSchema(): string {
  return `stream_test_${crypto.randomUUID().replaceAll('-', '_')}`;
}

function createStream(overrides?: Partial<StreamData>): StreamData {
  return {
    id: crypto.randomUUID(),
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    error: null,
    ...overrides,
  };
}

function textDeltaChunk(
  seq: number,
  delta = `chunk-${seq}`,
): StreamChunkData['data'] {
  return { type: 'text-delta', id: `part-${seq}`, delta };
}

function createChunk(
  streamId: string,
  seq: number,
  data: StreamChunkData['data'] = textDeltaChunk(seq),
): StreamChunkData {
  return {
    streamId,
    seq,
    data,
    createdAt: Date.now(),
  };
}

async function withStore<T>(
  fn: (store: PostgresStreamStore) => Promise<T>,
): Promise<T> {
  await using container = await testPostgres.database();

  const schema = testSchema();
  const store = await openStoreWithRetry(container.pool(), schema);
  return await fn(store);
}

function openStoreWithRetry(
  pool: pg.Pool,
  schema: string,
): Promise<PostgresStreamStore> {
  return retryUntilReady(() => PostgresStreamStore.create({ pool, schema }), {
    retries: 9,
    minTimeout: 100,
    maxRetryTime: Number.POSITIVE_INFINITY,
    shouldRetry: ({ error }) => isTransientPostgresStartupError(error),
  });
}

function isTransientPostgresStartupError(error: unknown): boolean {
  const maybeCode =
    Error.isError(error) && 'code' in error ? error.code : undefined;
  return (
    maybeCode === 'ECONNRESET' ||
    maybeCode === 'ECONNREFUSED' ||
    maybeCode === '57P03'
  );
}

describe('PostgreSQL StreamStore Integration', () => {
  it('creates a new schema while other stores create it at the same time', async () => {
    await using container = await testPostgres.database();
    const schema = testSchema();

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        PostgresStreamStore.create({
          pool: container.pool(),
          schema,
        }),
      ),
    );
    const stores = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    assert.deepStrictEqual(
      results.map((result) =>
        result.status === 'fulfilled' ? 'opened' : result.reason.code,
      ),
      ['opened', 'opened', 'opened'],
    );
    const stream = createStream();
    await stores[0].createStream(stream);
    assert.deepStrictEqual(await stores[2].getStream(stream.id), stream);
  });

  it('should create, upsert, retrieve, update, and list streams', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        id: 'stream-a',
        createdAt: 100,
      });

      await store.createStream(stream);
      assert.deepStrictEqual(await store.getStream(stream.id), stream);

      const existing = await store.upsertStream({
        ...stream,
        status: 'running',
        createdAt: 200,
      });
      assert.strictEqual(existing.created, false);
      assert.deepStrictEqual(existing.stream, stream);

      const inserted = await store.upsertStream(
        createStream({
          id: 'stream-b',
          status: 'running',
          createdAt: 50,
          startedAt: 60,
        }),
      );
      assert.strictEqual(inserted.created, true);

      assert.deepStrictEqual(await store.listStreamIds(), [
        'stream-b',
        'stream-a',
      ]);
      assert.deepStrictEqual(await store.listStreamIds({ status: 'running' }), [
        'stream-b',
      ]);

      await store.updateStreamStatus('stream-a', 'running');
      assert.strictEqual(await store.getStreamStatus('stream-a'), 'running');

      await store.updateStreamStatus('stream-a', 'failed', {
        error: 'boom',
      });
      const failed = await store.getStream('stream-a');
      assert.ok(failed);
      assert.strictEqual(failed.status, 'failed');
      assert.strictEqual(failed.error, 'boom');
      assert.ok(failed.startedAt);
      assert.ok(failed.finishedAt);
    }));

  it('lists only the stream ids that start with a literal prefix', async () =>
    await withStore(async (store) => {
      for (const [createdAt, id, status] of [
        [1, 'turn:a_b%:2', 'running'],
        [2, 'turn:a_b%:1', 'completed'],
        [3, 'turn:aXbYZ:1', 'running'],
        [4, 'TURN:A_B%:1', 'running'],
        [5, 'other:turn:a_b%:1', 'running'],
      ] as const) {
        await store.createStream(createStream({ id, status, createdAt }));
      }
      const all = [
        'turn:a_b%:2',
        'turn:a_b%:1',
        'turn:aXbYZ:1',
        'TURN:A_B%:1',
        'other:turn:a_b%:1',
      ];

      assert.deepStrictEqual(
        await store.listStreamIds({ prefix: 'turn:a_b%:' }),
        ['turn:a_b%:2', 'turn:a_b%:1'],
      );
      assert.deepStrictEqual(
        await store.listStreamIds({ prefix: 'turn:a_b%:', status: 'running' }),
        ['turn:a_b%:2'],
      );
      assert.deepStrictEqual(await store.listStreamIds({ prefix: '' }), all);
      assert.deepStrictEqual(await store.listStreamIds(), all);
    }));

  it('should not overwrite a committed cancellation with late terminal writes', async () =>
    await withStore(async (store) => {
      const stream = createStream();
      await store.createStream(stream);
      assert.equal(
        (
          await store.updateStream(stream.id, ({ status }) =>
            status === 'queued'
              ? { status: 'running', startedAt: Date.now() }
              : undefined,
          )
        ).updated,
        true,
      );
      assert.equal(
        (
          await store.updateStream(stream.id, ({ status }) => {
            if (status !== 'queued' && status !== 'running') return undefined;
            const now = Date.now();
            return {
              status: 'cancelled',
              cancelRequestedAt: now,
              finishedAt: now,
            };
          })
        ).updated,
        true,
      );

      await store.updateStreamStatus(stream.id, 'completed');
      await store.updateStreamStatus(stream.id, 'failed', {
        error: 'late failure',
      });
      await store.updateStreamStatus(stream.id, 'queued');
      await store.appendChunks([
        createChunk(stream.id, 0, {
          type: 'error',
          errorText: 'late error chunk',
        }),
      ]);

      const cancelled = await store.getStream(stream.id);
      assert.equal(cancelled?.status, 'cancelled');
      assert.equal(cancelled?.error, null);
    }));

  it('allows exactly one caller to transition a queued stream', async () =>
    await withStore(async (store) => {
      const stream = createStream();
      await store.createStream(stream);
      const transition = () =>
        store.updateStream(stream.id, ({ status }) =>
          status === 'queued'
            ? { status: 'running', startedAt: Date.now() }
            : undefined,
        );

      const results = await Promise.all([transition(), transition()]);

      assert.equal(results.filter(({ updated }) => updated).length, 1);
      assert.equal(await store.getStreamStatus(stream.id), 'running');
    }));

  it('should append and read JSONB chunks with ordering, paging, and multi-stream batches', async () =>
    await withStore(async (store) => {
      const streamA = createStream({ id: 'stream-a' });
      const streamB = createStream({ id: 'stream-b' });
      await store.createStream(streamA);
      await store.createStream(streamB);

      const payload: StreamChunkData['data'] = {
        type: 'tool-output-available',
        toolCallId: 'tool-1',
        output: {
          nested: { ok: true, count: 2 },
          items: ['a', 'b', null],
        },
      };

      await store.appendChunks([
        createChunk(streamA.id, 0, textDeltaChunk(0, 'zero')),
        createChunk(streamB.id, 0, textDeltaChunk(0, 'other')),
        createChunk(streamA.id, 1, payload),
        createChunk(streamA.id, 2, { type: 'finish' }),
      ]);

      const allA = await store.getChunks(streamA.id);
      assert.deepStrictEqual(
        allA.map((chunk) => chunk.seq),
        [0, 1, 2],
      );
      assert.deepStrictEqual(allA[1].data, payload);

      const pagedA = await store.getChunks(streamA.id, 1, 1);
      assert.strictEqual(pagedA.length, 1);
      assert.strictEqual(pagedA[0].seq, 1);
      assert.deepStrictEqual(pagedA[0].data, payload);

      const allB = await store.getChunks(streamB.id);
      assert.strictEqual(allB.length, 1);
      assert.deepStrictEqual(allB[0].data, textDeltaChunk(0, 'other'));

      await store.appendChunks([]);
      assert.strictEqual((await store.getChunks(streamA.id)).length, 3);
    }));

  it('should atomically append chunks and fail a stream', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);

      const errorChunk: StreamChunkData['data'] = {
        type: 'error',
        errorText: 'direct failure',
      };

      await store.appendChunks([createChunk(stream.id, 0, errorChunk)]);

      const updated = await store.getStream(stream.id);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'failed');
      assert.strictEqual(updated.error, 'direct failure');
      assert.ok(updated.finishedAt);

      const chunks = await store.getChunks(stream.id);
      assert.strictEqual(chunks.length, 1);
      assert.deepStrictEqual(chunks[0].data, errorChunk);
    }));

  it('should not fail a stream for tool error chunks', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);

      const toolInputError: StreamChunkData['data'] = {
        type: 'tool-input-error',
        toolCallId: 'tool-1',
        toolName: 'search',
        input: { query: 'bad' },
        errorText: 'invalid input',
      };
      const toolOutputError: StreamChunkData['data'] = {
        type: 'tool-output-error',
        toolCallId: 'tool-1',
        errorText: 'tool failed',
      };

      await store.appendChunks([
        createChunk(stream.id, 0, toolInputError),
        createChunk(stream.id, 1, toolOutputError),
      ]);

      const updated = await store.getStream(stream.id);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'running');
      assert.strictEqual(updated.error, null);
      assert.deepStrictEqual(
        (await store.getChunks(stream.id)).map((chunk) => chunk.data),
        [toolInputError, toolOutputError],
      );
    }));

  it('should reject missing-stream error chunks without storing chunks', async () =>
    await withStore(async (store) => {
      await assert.rejects(
        () =>
          store.appendChunks([
            createChunk('missing-stream', 0, {
              type: 'error',
              errorText: 'missing target',
            }),
          ]),
        /foreign key|constraint|violates|not found/i,
      );

      assert.deepStrictEqual(await store.getChunks('missing-stream'), []);
    }));

  it('should roll back failed status when atomic append fails', async () =>
    await withStore(async (store) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      await store.appendChunks([createChunk(stream.id, 0)]);

      await assert.rejects(
        () =>
          store.appendChunks([
            createChunk(stream.id, 0, {
              type: 'error',
              errorText: 'should roll back',
            }),
          ]),
        /duplicate key|unique/i,
      );

      const updated = await store.getStream(stream.id);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'running');
      assert.strictEqual(updated.error, null);
    }));

  it('should delete chunks by cascade and reopen only terminal streams', async () =>
    await withStore(async (store) => {
      const queued = createStream({ id: 'queued' });
      const running = createStream({ id: 'running', status: 'running' });
      const completed = createStream({ id: 'completed', status: 'completed' });
      await store.createStream(queued);
      await store.createStream(running);
      await store.createStream(completed);
      await store.appendChunks([
        createChunk(completed.id, 0),
        createChunk(completed.id, 1),
      ]);

      await assert.rejects(
        () => store.reopenStream(queued.id),
        /Only terminal streams can be reopened/,
      );
      await assert.rejects(
        () => store.reopenStream(running.id),
        /Only terminal streams can be reopened/,
      );

      const reopened = await store.reopenStream(completed.id);
      assert.strictEqual(reopened.id, completed.id);
      assert.strictEqual(reopened.status, 'queued');
      assert.strictEqual(reopened.startedAt, null);
      assert.strictEqual(reopened.finishedAt, null);
      assert.deepStrictEqual(await store.getChunks(completed.id), []);

      await store.appendChunks([createChunk(reopened.id, 0)]);
      await store.deleteStream(reopened.id);
      assert.strictEqual(await store.getStream(reopened.id), undefined);
      assert.deepStrictEqual(await store.getChunks(reopened.id), []);
    }));

  it('should tail a PostgreSQL stream through PollingChangeSource without notify triggers', async (t) =>
    await withStore(async (store) => {
      const stream = createStream({
        status: 'running',
        startedAt: Date.now(),
      });
      await store.createStream(stream);
      await store.appendChunks([createChunk(stream.id, 0)]);

      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({
          reads: store,
          backoff: new Backoff({
            initial: 5,
            multiplier: 1,
            max: 5,
            jitter: { kind: 'none' },
          }),
          statusCheckEvery: 1,
        }),
      });

      const consume = Array.fromAsync(manager.watch(stream.id));

      await store.appendChunks([createChunk(stream.id, 1)]);
      await store.updateStreamStatus(stream.id, 'completed');
      const received = await untilAborted(consume, t.signal);

      assert.deepStrictEqual(received, [textDeltaChunk(0), textDeltaChunk(1)]);
    }));

  it('delivers each PostgreSQL chunk to a watcher before the producer sends the next', async (t) =>
    await withStore(async (store) => {
      const streamId = crypto.randomUUID();
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({
          reads: store,
          backoff: new Backoff({
            initial: 5,
            multiplier: 1,
            max: 5,
            jitter: { kind: 'none' },
          }),
          statusCheckEvery: 1,
        }),
      });
      await manager.register(streamId);
      const parts: UIMessageChunk[] = [
        { type: 'start', messageId: 'answer' },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Hel' },
        { type: 'text-delta', id: 'text-1', delta: 'lo' },
        { type: 'text-end', id: 'text-1' },
      ];
      using source = streamHarness.source<UIMessageChunk>();
      const persisted = manager.persist(source.stream, streamId);
      await using watcher = streamHarness.reader(manager.watch(streamId));
      try {
        for (const part of parts) {
          source.enqueue(part);
          assert.deepStrictEqual(await untilAborted(watcher.read(), t.signal), {
            done: false,
            value: part,
          });
        }
        source.close();
        await persisted;
        assert.deepStrictEqual(await watcher.read(), {
          done: true,
          value: undefined,
        });
      } finally {
        source[Symbol.dispose]();
        await persisted.catch(() => undefined);
      }
    }));

  it('should fail a PostgreSQL persisted stream when a top-level error chunk is persisted', async (t) =>
    await withStore(async (store) => {
      const streamId = crypto.randomUUID();
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({
          reads: store,
          backoff: new Backoff({
            initial: 5,
            multiplier: 1,
            max: 5,
            jitter: { kind: 'none' },
          }),
          statusCheckEvery: 1,
        }),
      });
      await manager.register(streamId);

      const errorText = 'postgres stream failed';
      const source = simulateReadableStream<UIMessageChunk>({
        chunks: [
          { type: 'text-start', id: 'part-1' },
          { type: 'text-delta', id: 'part-1', delta: 'before' },
          { type: 'error', errorText },
          { type: 'finish' },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: 25,
      });

      const persistPromise = manager.persist(source, streamId);

      await waitFor(
        async () =>
          assert.strictEqual(await store.getStreamStatus(streamId), 'failed'),
        { signal: t.signal, interval: 10 },
      );
      await untilAborted(persistPromise, t.signal);

      const updated = await store.getStream(streamId);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'failed');
      assert.strictEqual(updated.error, errorText);

      const chunks = await store.getChunks(streamId);
      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.data),
        [
          { type: 'text-start', id: 'part-1' },
          { type: 'text-delta', id: 'part-1', delta: 'before' },
          { type: 'error', errorText },
          { type: 'finish' },
        ],
      );
    }));

  it('fails a PostgreSQL persisted stream with the error of a source that errors, and rejects with it', async () =>
    await withStore(async (store) => {
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({ reads: store }),
      });
      const streamId = crypto.randomUUID();
      await manager.register(streamId);
      const sourceError = new Error('postgres source broke');
      const source = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'part-1' });
        },
        pull(controller) {
          controller.error(sourceError);
        },
      });

      const rejection = await manager.persist(source, streamId).then(
        () => 'resolved',
        (error: unknown) => error,
      );

      const stored = await store.getStream(streamId);
      assert.deepStrictEqual(
        {
          rejection,
          status: stored?.status,
          error: stored?.error,
          chunks: (await store.getChunks(streamId)).map(({ data }) => data),
        },
        {
          rejection: sourceError,
          status: 'failed',
          error: 'postgres source broke',
          chunks: [{ type: 'text-start', id: 'part-1' }],
        },
      );
      assert.strictEqual(rejection, sourceError);
    }));

  it('cancels a PostgreSQL persisted stream whose source sends an abort chunk and then errors with an AbortError, and resolves', async () =>
    await withStore(async (store) => {
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({ reads: store }),
      });
      const streamId = crypto.randomUUID();
      await manager.register(streamId);
      const source = new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'text-start', id: 'part-1' });
          controller.enqueue({ type: 'abort' });
        },
        pull(controller) {
          controller.error(
            new DOMException('This operation was aborted', 'AbortError'),
          );
        },
      });

      const outcome = await manager.persist(source, streamId).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

      const stored = await store.getStream(streamId);
      assert.deepStrictEqual(
        {
          outcome,
          status: stored?.status,
          error: stored?.error,
          chunks: (await store.getChunks(streamId)).map(({ data }) => data),
        },
        {
          outcome: { result: { streamId } },
          status: 'cancelled',
          error: null,
          chunks: [{ type: 'text-start', id: 'part-1' }, { type: 'abort' }],
        },
      );
    }));

  it('should retain partial output and fail a PostgreSQL interrupted stream', async () =>
    withStore(async (store) => {
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({ reads: store }),
      });
      const streamId = crypto.randomUUID();
      await manager.register(streamId);
      const parts: UIMessageChunk[] = [
        { type: 'start' },
        { type: 'text-start', id: 'partial' },
        { type: 'text-delta', id: 'partial', delta: 'Partial answer' },
        { type: 'text-end', id: 'partial' },
        { type: 'finish', finishReason: 'interrupted' },
      ];

      await manager.persist(ReadableStream.from(parts), streamId);
      await store.updateStreamStatus(streamId, 'completed');

      assert.equal((await store.getStream(streamId))?.status, 'failed');
      assert.deepEqual(
        (await store.getChunks(streamId)).map(({ data }) => data),
        parts,
      );
      const replay = await Array.fromAsync(manager.watch(streamId));
      assert.ok(replay.some((part) => part.type === 'error'));
    }));

  it('should complete a PostgreSQL persisted stream for tool error chunks', async () =>
    await withStore(async (store) => {
      const streamId = crypto.randomUUID();
      const manager = new StreamManager({
        store,
        changeSource: new PollingChangeSource({
          reads: store,
          backoff: new Backoff({
            initial: 5,
            multiplier: 1,
            max: 5,
            jitter: { kind: 'none' },
          }),
          statusCheckEvery: 1,
        }),
      });
      await manager.register(streamId);

      const source = simulateReadableStream<UIMessageChunk>({
        chunks: [
          {
            type: 'tool-input-error',
            toolCallId: 'tool-1',
            toolName: 'search',
            input: { query: 'bad' },
            errorText: 'invalid input',
          },
          {
            type: 'tool-output-error',
            toolCallId: 'tool-1',
            errorText: 'tool failed',
          },
          { type: 'finish' },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      });

      await manager.persist(source, streamId);

      const updated = await store.getStream(streamId);
      assert.ok(updated);
      assert.strictEqual(updated.status, 'completed');
      assert.strictEqual(updated.error, null);
    }));
});
