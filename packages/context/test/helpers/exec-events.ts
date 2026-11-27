import type { EngineApi } from '@zukhruf/docker';
import type { DockerTestbed } from '@zukhruf/testing/docker';
import assert from 'node:assert';
import type { Readable } from 'node:stream';

import type { DisposableSandbox } from '@deepagents/context';

/**
 * A stream of the exec events of the sandbox's container, open when it
 * resolves. The container's hostname is the start of its id. Open it before
 * the act, so that no event of the act comes before the stream, and destroy it
 * in a finally.
 */
export async function execEvents(
  testbed: Pick<DockerTestbed, 'client'>,
  sandbox: Pick<DisposableSandbox, 'readTextFile'>,
  signal: AbortSignal,
) {
  const hostname = (
    await sandbox.readTextFile({ path: '/etc/hostname' })
  )?.trim();
  assert.ok(hostname, 'the sandbox has a hostname');
  return (await testbed.client()).watch({
    filters: {
      type: ['container'],
      container: [hostname],
      event: ['exec_create', 'exec_start', 'exec_die'],
    },
    signal,
  });
}

/**
 * Follows, on a stream of execEvents, the exec whose command holds each
 * marker: `started` resolves at its exec_start, `ended` at its exec_die with
 * its exit code. The Action of exec_create and exec_start holds the whole
 * command the sandbox runs (its `bash -c` wrapper too), so a marker matches
 * any part of it. The exec_die names no command, so it is matched by the
 * execID of the exec_create. Both reject when the stream ends or fails first.
 */
export function execsOf(events: Readable, ...markers: string[]) {
  const execs: {
    marker: string;
    id?: string;
    started: PromiseWithResolvers<void>;
    ended: PromiseWithResolvers<string | undefined>;
  }[] = markers.map((marker) => ({
    marker,
    started: Promise.withResolvers<void>(),
    ended: Promise.withResolvers<string | undefined>(),
  }));
  void (async () => {
    let running = execs.length;
    for await (const event of events) {
      const { Action = '', Actor }: EngineApi.EventMessage = event;
      const id = Actor?.Attributes?.execID;
      for (const exec of execs) {
        if (Action.startsWith('exec_create') && Action.includes(exec.marker)) {
          exec.id = id;
        } else if (
          Action.startsWith('exec_start') &&
          Action.includes(exec.marker)
        ) {
          exec.started.resolve();
        } else if (
          Action === 'exec_die' &&
          exec.id !== undefined &&
          id === exec.id
        ) {
          exec.ended.resolve(Actor?.Attributes?.exitCode);
          running -= 1;
        }
      }
      if (running === 0) return;
    }
    throw new Error('the stream of exec events ended before each exec died');
  })().catch((error: unknown) => {
    for (const { started, ended } of execs) {
      started.reject(error);
      ended.reject(error);
    }
  });
  return execs.map(({ started, ended }) => {
    // A test that fails before it awaits them destroys the stream: that
    // rejection must not become an unhandled one.
    started.promise.catch(() => undefined);
    ended.promise.catch(() => undefined);
    return { started: started.promise, ended: ended.promise };
  });
}
