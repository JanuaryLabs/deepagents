import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type ChatSandbox,
  DockerSandboxEnvironment,
  type SandboxContext,
  SandboxNotFoundError,
} from '@deepagents/context';

const temporaryFiles = new TemporaryFiles();
const testbed = new DockerTestbed({ environment: process.env });
const container = await testbed.defaults();

function chat(chatId: string): SandboxContext {
  return { chatId, userId: 'user-1' };
}

function uniqueNamespace(): string {
  return `test-${randomUUID()}`;
}

/** The containers that carry the namespace's labels, and the chat's when given. */
async function chatContainers(namespace: string, chatId?: string) {
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

/** The one container of the chat, found by its labels. */
async function chatContainer(namespace: string, chatId: string) {
  const [summary, ...others] = await chatContainers(namespace, chatId);
  assert.ok(summary?.Id, `chat "${chatId}" must have a container`);
  assert.deepStrictEqual(others, [], `chat "${chatId}" has one container`);
  const found = await (await testbed.client()).containers.find(summary.Id);
  assert.ok(found, `container ${summary.Id} must exist`);
  return found;
}

async function status(namespace: string, chatId: string) {
  const found = await chatContainer(namespace, chatId);
  return (await found.inspect()).State?.Status;
}

/** Removes every container of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  const client = await testbed.client();
  for (const { Id } of await chatContainers(namespace)) {
    if (Id === undefined) continue;
    await (await client.containers.find(Id))?.remove({ force: true });
  }
}

/** How each operation of `sandbox` ends: resolved, or the error's class. */
async function outcomes(sandbox: ChatSandbox): Promise<Record<string, string>> {
  const operations = {
    run: () => sandbox.run({ command: 'true' }),
    'run with a signal': () =>
      sandbox.run({
        command: 'true',
        abortSignal: new AbortController().signal,
      }),
    spawn: () => sandbox.spawn({ command: 'true' }),
    readFile: () => sandbox.readBinaryFile({ path: '/etc/hostname' }),
    writeFile: () =>
      sandbox.writeTextFile({ path: 'note.txt', content: 'note' }),
    stat: () => sandbox.stat({ path: '/etc/hostname' }),
    resume: () => sandbox.resume(),
  };
  const result: Record<string, string> = {};
  for (const [operation, call] of Object.entries(operations)) {
    result[operation] = await Promise.resolve(call()).then(
      () => 'resolved',
      (error: Error) =>
        error instanceof SandboxNotFoundError
          ? 'SandboxNotFoundError'
          : `${error.name}: ${error.message}`,
    );
  }
  return result;
}

function every(value: string): Record<string, string> {
  return Object.fromEntries(
    [
      'run',
      'run with a signal',
      'spawn',
      'readFile',
      'writeFile',
      'stat',
      'resume',
    ].map((operation) => [operation, value]),
  );
}

describe('DockerSandboxEnvironment', () => {
  it("keeps the chat's container running under another handle's command when the handle that created it closes", async () => {
    const namespace = uniqueNamespace();
    const thisWorker = new DockerSandboxEnvironment({ namespace, container });
    const otherWorker = new DockerSandboxEnvironment({ namespace, container });
    try {
      const creator = await thisWorker.open(chat('c'));
      await using sibling = await thisWorker.open(chat('c'));
      await using other = await otherWorker.open(chat('c'));

      const commands = [sibling, other].map((sandbox) =>
        sandbox.run({
          command: 'sleep 3; echo done',
          abortSignal: new AbortController().signal,
        }),
      );
      await delay(1_000);
      await creator.close();

      const results = await Promise.all(commands);
      assert.deepStrictEqual(
        results.map(({ exitCode, stdout }) => ({ exitCode, stdout })),
        [
          { exitCode: 0, stdout: 'done\n' },
          { exitCode: 0, stdout: 'done\n' },
        ],
      );
      assert.strictEqual(await status(namespace, 'c'), 'running');
      const after = await sibling.run({ command: 'echo still' });
      assert.strictEqual(after.stdout, 'still\n');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('rejects every operation of a handle with SandboxNotFoundError once its chat is deleted, also after the chat is opened again', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using stale = await environment.open(chat('c'));
      await environment.delete(chat('c'));

      assert.deepStrictEqual(
        await outcomes(stale),
        every('SandboxNotFoundError'),
      );

      await using fresh = await environment.open(chat('c'));
      assert.deepStrictEqual(
        await outcomes(stale),
        every('SandboxNotFoundError'),
      );
      assert.deepStrictEqual(await outcomes(fresh), every('resolved'));
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('rejects resume with SandboxNotFoundError when the container was removed outside, or replaced under its name', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using removed = await environment.open(chat('c'));
      await (await chatContainer(namespace, 'c')).remove({ force: true });
      assert.deepStrictEqual(
        await outcomes(removed),
        every('SandboxNotFoundError'),
      );

      await using replaced = await environment.open(chat('c'));
      const original = await chatContainer(namespace, 'c');
      const client = await testbed.client();
      const { Name: name, Config: created } = await original.inspect();
      assert.ok(name, 'the container has a name');
      await original.remove({ force: true });
      // Platform setup no operation exposes: another container takes the name.
      await using replacement = await testbed.start(
        {
          Image: created?.Image,
          Cmd: ['tail', '-f', '/dev/null'],
          Labels: {
            ...container.Labels,
            'deepagents.sandbox.namespace': namespace,
            'deepagents.sandbox.chat': 'c',
          },
        },
        { name: name.replace(/^\//, '') },
      );
      assert.ok(await client.containers.find(replacement.id));

      assert.deepStrictEqual(
        await outcomes(replaced),
        every('SandboxNotFoundError'),
      );
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('closes a handle once and rejects its operations with an error that names the chat, leaving the container running', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using sibling = await environment.open(chat('closed-chat'));
      const handle = await environment.open(chat('closed-chat'));
      await handle.close();
      await handle.close();
      await handle[Symbol.asyncDispose]();
      const fromSibling = await sibling.run({ command: 'echo sibling' });
      assert.strictEqual(fromSibling.stdout, 'sibling\n');
      await sibling.close();

      const result = await outcomes(handle);
      assert.deepStrictEqual(
        result,
        every('Error: The sandbox handle of chat "closed-chat" is closed.'),
      );
      assert.strictEqual(await status(namespace, 'closed-chat'), 'running');

      await using reopened = await environment.open(chat('closed-chat'));
      const echo = await reopened.run({ command: 'echo reopened' });
      assert.strictEqual(echo.stdout, 'reopened\n');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('stops and deletes without ever starting the container, and resolves when there is none', async () => {
    const namespace = uniqueNamespace();
    await using starts = await testbed.directory();
    const environment = new DockerSandboxEnvironment({
      namespace,
      container,
      command: [
        'sh',
        '-c',
        'echo start >> /starts/log; exec tail -f /dev/null',
      ],
      volumes: () => [
        {
          type: 'bind',
          hostPath: starts.path,
          containerPath: '/starts',
          readOnly: false,
        },
      ],
    });
    const otherWorker = new DockerSandboxEnvironment({ namespace, container });
    try {
      await environment.stop(chat('c'));
      await environment.delete(chat('c'));

      await using running = await otherWorker.open(chat('running'));
      await environment.delete(chat('running'));
      assert.deepStrictEqual(await chatContainers(namespace, 'running'), []);

      const handle = await environment.open(chat('c'));
      await handle.close();
      await environment.stop(chat('c'));
      await environment.stop(chat('c'));
      assert.strictEqual(await status(namespace, 'c'), 'exited');

      await environment.delete(chat('c'));
      await environment.delete(chat('c'));
      await environment.stop(chat('c'));

      assert.deepStrictEqual(await chatContainers(namespace, 'c'), []);
      assert.strictEqual(await starts.readFile('log'), 'start\n');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it(
    'leaves no zombie process after an aborted command',
    { timeout: 30_000 },
    async (t) => {
      const namespace = uniqueNamespace();
      const environment = new DockerSandboxEnvironment({
        namespace,
        container,
      });
      try {
        await using sandbox = await environment.open(chat('c'));
        const controller = new AbortController();
        const command = Promise.resolve(
          sandbox.run({
            command: 'sleep 300 & sleep 300 & wait',
            abortSignal: controller.signal,
          }),
        );
        // The state of each sleep process: S while it runs, Z once it is a zombie.
        const sleeps = async () =>
          (
            await sandbox.run({
              command:
                'for f in /proc/[0-9]*/status; do n=; s=; while read -r k v _; do case $k in Name:) n=$v ;; State:) s=$v ;; esac; done < "$f" 2>/dev/null; [ "$n" = sleep ] && echo "$s"; done; true',
            })
          ).stdout;
        await waitFor(
          async () => assert.strictEqual(await sleeps(), 'S\nS\n'),
          {
            signal: t.signal,
          },
        );
        controller.abort();
        await assert.rejects(command);

        await waitFor(async () => assert.strictEqual(await sleeps(), ''), {
          signal: t.signal,
        });
      } finally {
        await removeNamespace(namespace);
      }
    },
  );

  it('opens one container per chat that two handles share, found by its labels, kept when it stops and run by an init process', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using writer = await environment.open(chat('c'));
      await using reader = await environment.open(chat('c'));
      await writer.writeTextFile({ path: 'note.txt', content: 'shared' });

      assert.strictEqual(
        await reader.readTextFile({ path: 'note.txt' }),
        'shared',
      );
      const info = await (await chatContainer(namespace, 'c')).inspect();
      assert.deepStrictEqual(
        {
          autoRemove: info.HostConfig?.AutoRemove,
          init: info.HostConfig?.Init,
          namespace: info.Config?.Labels?.['deepagents.sandbox.namespace'],
          chat: info.Config?.Labels?.['deepagents.sandbox.chat'],
        },
        { autoRemove: false, init: true, namespace, chat: 'c' },
      );
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('isolates chats from each other, and the same chat in another namespace', async () => {
    const namespace = uniqueNamespace();
    const otherNamespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    const otherEnvironment = new DockerSandboxEnvironment({
      namespace: otherNamespace,
      container,
    });
    try {
      await using a = await environment.open(chat('a'));
      await using b = await environment.open(chat('b'));
      await using elsewhere = await otherEnvironment.open(chat('a'));
      await using otherUser = await environment.open({
        chatId: 'a',
        userId: 'user-2',
      });
      await a.writeTextFile({ path: 'note.txt', content: 'only a' });

      assert.deepStrictEqual(
        {
          b: await b.readTextFile({ path: 'note.txt' }),
          elsewhere: await elsewhere.readTextFile({ path: 'note.txt' }),
          otherUser: await otherUser.readTextFile({ path: 'note.txt' }),
        },
        { b: null, elsewhere: null, otherUser: 'only a' },
      );
      const ids = new Set(
        [
          ...(await chatContainers(namespace)),
          ...(await chatContainers(otherNamespace)),
        ].map(({ Id }) => Id),
      );
      assert.strictEqual(ids.size, 3);
    } finally {
      await removeNamespace(namespace);
      await removeNamespace(otherNamespace);
    }
  });

  it('starts a stopped container again with its files, through open and through resume, and stops it on SIGTERM through its init', async (t) => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using held = await environment.open(chat('c'));
      await held.writeTextFile({ path: 'note.txt', content: 'kept' });

      const stopping = performance.now();
      await environment.stop(chat('c'));
      const stopTime = performance.now() - stopping;
      t.diagnostic(`stop took ${Math.round(stopTime)} ms`);
      const stopped = await (await chatContainer(namespace, 'c')).inspect();
      assert.deepStrictEqual(
        { status: stopped.State?.Status, exitCode: stopped.State?.ExitCode },
        { status: 'exited', exitCode: 143 },
        'the init passes SIGTERM on, so the engine never waits out its grace to kill',
      );
      await using reopened = await environment.open(chat('c'));
      assert.strictEqual(
        await reopened.readTextFile({ path: 'note.txt' }),
        'kept',
      );

      await environment.stop(chat('c'));
      await held.resume();
      assert.strictEqual(await status(namespace, 'c'), 'running');
      const read = await held.run({ command: 'cat note.txt' });
      assert.strictEqual(read.stdout, 'kept');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('starts a container that was created and never started', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      const first = await environment.open(chat('c'));
      await first.close();
      const original = await chatContainer(namespace, 'c');
      const { Name: name, Config } = await original.inspect();
      assert.ok(name, 'the container has a name');
      await original.remove({ force: true });
      const client = await testbed.client();
      // Platform setup no operation exposes: a container created, never started.
      await client.containers.create(
        {
          Image: Config?.Image,
          Cmd: ['tail', '-f', '/dev/null'],
          Labels: Config?.Labels,
        },
        { name: name.replace(/^\//, '') },
      );
      assert.strictEqual(await status(namespace, 'c'), 'created');

      await using opened = await environment.open(chat('c'));
      const echo = await opened.run({ command: 'echo started' });
      assert.strictEqual(echo.stdout, 'started\n');
      assert.strictEqual(await status(namespace, 'c'), 'running');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('connects to no engine before the first open', async () => {
    await using directory = await temporaryFiles.directory('sandbox-env-');
    const socket = join(directory.path, 'engine.sock');
    let connections = 0;
    const engine = createServer((connection) => {
      connections++;
      connection.destroy();
    });
    await new Promise<void>((resolve) => engine.listen(socket, resolve));
    try {
      const environment = new DockerSandboxEnvironment({
        namespace: uniqueNamespace(),
        container,
        environment: { DOCKER_HOST: `unix://${socket}` },
      });
      await delay(100);
      assert.strictEqual(connections, 0);

      await assert.rejects(environment.open(chat('c')));
      assert.ok(connections > 0, 'open connects to the engine');
    } finally {
      await new Promise((resolve) => engine.close(resolve));
    }
  });

  it('unpauses a paused container, through open and through resume', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    try {
      await using held = await environment.open(chat('c'));

      await (await chatContainer(namespace, 'c')).pause();
      await using reopened = await environment.open(chat('c'));
      const fromOpen = await reopened.run({ command: 'echo open' });
      assert.deepStrictEqual(
        { exitCode: fromOpen.exitCode, stdout: fromOpen.stdout },
        { exitCode: 0, stdout: 'open\n' },
      );

      await (await chatContainer(namespace, 'c')).pause();
      await held.resume();
      const fromResume = await held.run({ command: 'echo resume' });
      assert.deepStrictEqual(
        { exitCode: fromResume.exitCode, stdout: fromResume.stdout },
        { exitCode: 0, stdout: 'resume\n' },
      );
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('mounts the volumes the environment gives for each chat, and delete leaves the named volume', async () => {
    const namespace = uniqueNamespace();
    await using files = await testbed.directory();
    await files.mkdir('a');
    await files.mkdir('b');
    await using shared = await testbed.volume();
    const environment = new DockerSandboxEnvironment({
      namespace,
      container,
      volumes: ({ chatId }) => [
        {
          type: 'bind',
          hostPath: `${files.path}/${chatId}`,
          containerPath: '/chat',
          readOnly: false,
        },
        {
          type: 'volume',
          name: shared.name,
          containerPath: '/shared',
          readOnly: false,
        },
      ],
    });
    try {
      await using a = await environment.open(chat('a'));
      await using b = await environment.open(chat('b'));
      await a.writeTextFile({ path: '/chat/own.txt', content: 'of a' });
      await a.writeTextFile({ path: '/shared/all.txt', content: 'from a' });

      assert.deepStrictEqual(
        {
          host: await files.readFile('a/own.txt'),
          bOwn: await b.readTextFile({ path: '/chat/own.txt' }),
          bShared: await b.readTextFile({ path: '/shared/all.txt' }),
        },
        { host: 'of a', bOwn: null, bShared: 'from a' },
      );

      await environment.delete(chat('a'));
      await environment.delete(chat('b'));
      const volume = await (await testbed.client()).volumes.find(shared.name);
      assert.strictEqual(volume?.name, shared.name);
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('runs readiness on every open, and a failed readiness rejects the open and leaves the container', async () => {
    const namespace = uniqueNamespace();
    const ready: string[] = [];
    let fail = false;
    const environment = new DockerSandboxEnvironment({
      namespace,
      container,
      readiness: async (sandbox) => {
        const { stdout } = await sandbox.run({ command: 'echo ready' });
        ready.push(stdout);
        if (fail) throw new Error('not ready');
      },
    });
    try {
      await using first = await environment.open(chat('c'));
      await using second = await environment.open(chat('c'));
      fail = true;
      await assert.rejects(environment.open(chat('c')), /not ready/);

      assert.deepStrictEqual(ready, ['ready\n', 'ready\n', 'ready\n']);
      assert.strictEqual(await status(namespace, 'c'), 'running');
      const after = await second.run({ command: 'echo after' });
      assert.strictEqual(after.stdout, 'after\n');
    } finally {
      await removeNamespace(namespace);
    }
  });

  it('makes one container for concurrent opens of a chat', async () => {
    const namespace = uniqueNamespace();
    const environment = new DockerSandboxEnvironment({ namespace, container });
    const otherWorker = new DockerSandboxEnvironment({ namespace, container });
    const handles: ChatSandbox[] = [];
    try {
      handles.push(
        ...(await Promise.all([
          environment.open(chat('c')),
          environment.open(chat('c')),
          otherWorker.open(chat('c')),
        ])),
      );
      const [first, ...rest] = handles;
      assert.ok(first);
      await first.writeTextFile({ path: 'note.txt', content: 'one' });

      assert.deepStrictEqual(
        await Promise.all(
          rest.map((handle) => handle.readTextFile({ path: 'note.txt' })),
        ),
        ['one', 'one'],
      );
      assert.strictEqual((await chatContainers(namespace, 'c')).length, 1);
    } finally {
      for (const handle of handles) await handle.close();
      await removeNamespace(namespace);
    }
  });
});
