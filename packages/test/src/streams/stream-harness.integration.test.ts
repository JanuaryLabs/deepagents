import assert from 'node:assert/strict';
import type { ReadableStreamReadResult } from 'node:stream/web';
import { test } from 'node:test';

import { StreamHarness } from '@deepagents/test';

const streams = new StreamHarness();

test('a controlled source stays open between reads and drains on close', async () => {
  using source = streams.source<number>();
  await using reader = streams.reader(source.stream);
  const first = reader.read();
  source.enqueue(1);
  assert.deepEqual(await first, { done: false, value: 1 });
  assert.equal(source.state, 'open');

  source.enqueue(2);
  source.enqueue(3);
  source.close();
  assert.equal(source.state, 'closed');
  assert.deepEqual(await reader.collectUntilError(), {
    status: 'completed',
    chunks: [2, 3],
  });
  assert.throws(() => source.enqueue(4), TypeError);
  assert.throws(() => source.close(), TypeError);
});

test('source disposal on scope failure closes without discarding queued chunks', async () => {
  const source = streams.source<string>();
  const failure = new Error('test failed');
  assert.throws(() => {
    using scoped = source;
    scoped.enqueue('queued');
    throw failure;
  }, failure);

  assert.equal(source.state, 'closed');
  assert.deepEqual(await Array.fromAsync(source.stream), ['queued']);
  source[Symbol.dispose]();
});

test('collection retains delivered chunks and the original failure', async () => {
  using source = streams.source<number>();
  await using reader = streams.reader(source.stream);
  const result = reader.collectUntilError();
  const failure = new Error('producer failed');
  source.enqueue(1);
  source.error(failure);

  assert.deepEqual(await result, {
    status: 'errored',
    chunks: [1],
    error: failure,
  });
  assert.equal(source.state, 'errored');
  await assert.rejects(reader.read(), failure);
});

test('error discards unread chunks, including after a producer requests close', async () => {
  using source = streams.source<number>();
  source.enqueue(1);
  source.close();
  source.error(undefined);

  await using reader = streams.reader(source.stream);
  assert.deepEqual(await reader.collectUntilError(), {
    status: 'errored',
    chunks: [],
    error: undefined,
  });
  assert.equal(source.state, 'errored');
});

test('consumer cancellation marks the source and makes disposal harmless', async () => {
  using source = streams.source<number>();
  source.enqueue(1);
  source.close();
  await source.stream.cancel();
  assert.equal(source.state, 'cancelled');
  source.error(new Error('too late'));
  source[Symbol.dispose]();
  assert.equal(source.state, 'cancelled');
  assert.deepEqual(await Array.fromAsync(source.stream), []);
});

test('acquisitions are independent and readers do not eagerly pull or buffer', async () => {
  let pulls = 0;
  const stream = new ReadableStream<number>(
    {
      pull(controller) {
        controller.enqueue(++pulls);
      },
    },
    { highWaterMark: 0 },
  );
  await using reader = streams.reader(stream);
  await Promise.resolve();
  assert.equal(pulls, 0);
  assert.equal(stream.locked, true);
  assert.throws(() => streams.reader(stream), TypeError);
  assert.deepEqual(await reader.read(), { done: false, value: 1 });
  await Promise.resolve();
  assert.equal(pulls, 1);

  using independent = streams.source<string>();
  independent.enqueue('other');
  independent.close();
  assert.deepEqual(await Array.fromAsync(independent.stream), ['other']);
});

test('reader scope failure cancels pending reads through the lock and releases it', async () => {
  using source = streams.source<number>();
  const failure = new Error('test failed');
  let pending!: Promise<ReadableStreamReadResult<number>>;
  await assert.rejects(async () => {
    await using reader = streams.reader(source.stream);
    pending = reader.read();
    throw failure;
  }, failure);

  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(source.state, 'cancelled');
  assert.equal(source.stream.locked, false);
});

test('reader disposal awaits cancellation and releases the lock even if it fails', async () => {
  const cancelled = Promise.withResolvers<void>();
  let cancellations = 0;
  const stream = new ReadableStream({
    cancel() {
      cancellations++;
      return cancelled.promise;
    },
  });
  const reader = streams.reader(stream);
  const disposed = reader[Symbol.asyncDispose]();
  assert.equal(cancellations, 1);
  assert.equal(stream.locked, true);

  const failure = new Error('cancel failed');
  const rejected = assert.rejects(Promise.resolve(disposed), failure);
  cancelled.reject(failure);
  await rejected;
  assert.equal(stream.locked, false);
  await reader[Symbol.asyncDispose]();
  assert.equal(cancellations, 1);
});

test('disposing an unread errored stream does not mask a scope failure', async () => {
  using source = streams.source<number>();
  const failure = new Error('test failed');
  await assert.rejects(async () => {
    await using reader = streams.reader(source.stream);
    source.error(new Error('unread stream failure'));
    throw failure;
  }, failure);
  assert.equal(source.stream.locked, false);
});

test('completed readers release the lock without invoking the cancellation hook', async () => {
  let cancellations = 0;
  const stream = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
      controller.close();
    },
    cancel() {
      cancellations++;
    },
  });
  {
    await using reader = streams.reader(stream);
    assert.deepEqual(await reader.collectUntilError(), {
      status: 'completed',
      chunks: [1],
    });
  }
  assert.equal(cancellations, 0);
  assert.equal(stream.locked, false);
});
