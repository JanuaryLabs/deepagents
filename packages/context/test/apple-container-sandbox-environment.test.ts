import { TemporaryFiles } from '@zukhruf/fs';
import spawn from 'nano-spawn';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  AppleContainerSandboxEnvironment,
  type ChatSandbox,
  type SandboxContext,
} from '@deepagents/context';

import { appleContainerUnavailable } from './helpers/apple-container.ts';
import { every, outcomes } from './helpers/chat-sandbox-outcomes.ts';

const temporaryFiles = new TemporaryFiles();

function chat(chatId: string): SandboxContext {
  return { chatId, userId: 'user-1' };
}

function uniqueNamespace(): string {
  return `test-${randomUUID()}`;
}

interface ListedContainer {
  configuration: {
    id: string;
    image: { reference: string };
    labels?: Record<string, string>;
    useInit?: boolean;
  };
  status: { state: string };
}

/** The containers that carry the namespace's labels, and the chat's when given. */
async function chatContainers(
  namespace: string,
  chatId?: string,
): Promise<ListedContainer[]> {
  const { stdout } = await spawn('container', [
    'list',
    '--all',
    '--format',
    'json',
  ]);
  const listed: ListedContainer[] = JSON.parse(stdout);
  return listed.filter(({ configuration: { labels = {} } }) => {
    return (
      labels['deepagents.sandbox.namespace'] === namespace &&
      (chatId === undefined || labels['deepagents.sandbox.chat'] === chatId)
    );
  });
}

/** The one container of the chat, found by its labels. */
async function chatContainer(
  namespace: string,
  chatId: string,
): Promise<ListedContainer> {
  const [found, ...others] = await chatContainers(namespace, chatId);
  assert.ok(found, `chat "${chatId}" must have a container`);
  assert.deepStrictEqual(others, [], `chat "${chatId}" has one container`);
  return found;
}

async function state(namespace: string, chatId: string): Promise<string> {
  return (await chatContainer(namespace, chatId)).status.state;
}

/** Removes every container of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  for (const { configuration } of await chatContainers(namespace)) {
    await spawn('container', ['delete', '--force', configuration.id]);
  }
}

describe(
  'AppleContainerSandboxEnvironment',
  { skip: await appleContainerUnavailable() },
  () => {
    it('opens one container per chat that two handles share, found by its labels and run by an init process', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      try {
        await using writer = await environment.open(chat('c'));
        await using reader = await environment.open(chat('c'));
        await writer.writeTextFile({ path: 'note.txt', content: 'shared' });

        assert.strictEqual(
          await reader.readTextFile({ path: 'note.txt' }),
          'shared',
        );
        const { configuration, status } = await chatContainer(namespace, 'c');
        assert.deepStrictEqual(
          {
            init: configuration.useInit,
            namespace: configuration.labels?.['deepagents.sandbox.namespace'],
            chat: configuration.labels?.['deepagents.sandbox.chat'],
            state: status.state,
          },
          { init: true, namespace, chat: 'c', state: 'running' },
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('isolates chats from each other, and the same chat in another namespace', async () => {
      const namespace = uniqueNamespace();
      const otherNamespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      const otherEnvironment = new AppleContainerSandboxEnvironment({
        namespace: otherNamespace,
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
          ].map(({ configuration }) => configuration.id),
        );
        assert.strictEqual(ids.size, 3);
      } finally {
        await removeNamespace(namespace);
        await removeNamespace(otherNamespace);
      }
    });

    it('keeps a stopped container with its files, and starts it again through open and through resume', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      try {
        await using held = await environment.open(chat('c'));
        await held.writeTextFile({ path: 'note.txt', content: 'kept' });

        await environment.stop(chat('c'));
        assert.strictEqual(await state(namespace, 'c'), 'stopped');
        await using reopened = await environment.open(chat('c'));
        assert.strictEqual(
          await reopened.readTextFile({ path: 'note.txt' }),
          'kept',
        );

        await environment.stop(chat('c'));
        await held.resume();
        assert.strictEqual(await state(namespace, 'c'), 'running');
        const read = await held.run({ command: 'cat note.txt' });
        assert.strictEqual(read.stdout, 'kept');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('stops and deletes without ever starting the container, and resolves when there is none', async () => {
      const namespace = uniqueNamespace();
      await using starts = await temporaryFiles.directory('apple-env-starts-');
      const environment = new AppleContainerSandboxEnvironment({
        namespace,
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
      const otherWorker = new AppleContainerSandboxEnvironment({ namespace });
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
        assert.strictEqual(await state(namespace, 'c'), 'stopped');

        await environment.delete(chat('c'));
        await environment.delete(chat('c'));
        await environment.stop(chat('c'));

        assert.deepStrictEqual(await chatContainers(namespace, 'c'), []);
        assert.strictEqual(
          await readFile(join(starts.path, 'log'), 'utf-8'),
          'start\n',
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('rejects every operation of a handle with SandboxNotFoundError once its chat is deleted, also after the chat is opened again', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
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

    it('rejects every operation with SandboxNotFoundError when the container was removed outside, or replaced under its name', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      try {
        await using removed = await environment.open(chat('c'));
        const { configuration: gone } = await chatContainer(namespace, 'c');
        await spawn('container', ['delete', '--force', gone.id]);
        assert.deepStrictEqual(
          await outcomes(removed),
          every('SandboxNotFoundError'),
        );

        await using replaced = await environment.open(chat('c'));
        const { configuration: original } = await chatContainer(namespace, 'c');
        await spawn('container', ['delete', '--force', original.id]);
        // Platform setup no operation exposes: another container takes the name.
        await spawn('container', [
          'run',
          '--detach',
          '--name',
          original.id,
          '--label',
          `deepagents.sandbox.namespace=${namespace}`,
          '--label',
          'deepagents.sandbox.chat=c',
          original.image.reference,
          'tail',
          '-f',
          '/dev/null',
        ]);
        assert.strictEqual(await state(namespace, 'c'), 'running');

        assert.deepStrictEqual(
          await outcomes(replaced),
          every('SandboxNotFoundError'),
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it("keeps the chat's container running under another handle's command when the handle that created it closes", async () => {
      const namespace = uniqueNamespace();
      const thisWorker = new AppleContainerSandboxEnvironment({ namespace });
      const otherWorker = new AppleContainerSandboxEnvironment({ namespace });
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
        assert.strictEqual(await state(namespace, 'c'), 'running');
        const after = await sibling.run({ command: 'echo still' });
        assert.strictEqual(after.stdout, 'still\n');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('makes one container for concurrent opens of a chat', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      const otherWorker = new AppleContainerSandboxEnvironment({ namespace });
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
        assert.strictEqual(await state(namespace, 'c'), 'running');
      } finally {
        for (const handle of handles) await handle.close();
        await removeNamespace(namespace);
      }
    });

    it("mounts the volumes the environment gives for each chat, and keeps the named volume's files across a delete", async () => {
      const namespace = uniqueNamespace();
      await using files = await temporaryFiles.directory('apple-env-volumes-');
      await mkdir(join(files.path, 'a'));
      await mkdir(join(files.path, 'b'));
      const durable = `test-${randomUUID()}`;
      await spawn('container', ['volume', 'create', durable]);
      const environment = new AppleContainerSandboxEnvironment({
        namespace,
        volumes: ({ chatId }) => [
          {
            type: 'bind',
            hostPath: join(files.path, chatId),
            containerPath: '/chat',
            readOnly: false,
          },
          ...(chatId === 'a'
            ? [
                {
                  type: 'volume' as const,
                  name: durable,
                  containerPath: '/durable',
                  readOnly: false,
                },
              ]
            : []),
        ],
      });
      try {
        const a = await environment.open(chat('a'));
        await using b = await environment.open(chat('b'));
        await a.writeTextFile({ path: '/chat/own.txt', content: 'of a' });
        await a.writeTextFile({ path: '/durable/kept.txt', content: 'kept' });
        const bOwn = await b.readTextFile({ path: '/chat/own.txt' });
        await a.close();

        await environment.delete(chat('a'));
        await using again = await environment.open(chat('a'));
        assert.deepStrictEqual(
          {
            host: await readFile(join(files.path, 'a', 'own.txt'), 'utf-8'),
            bOwn,
            durable: await again.readTextFile({ path: '/durable/kept.txt' }),
          },
          { host: 'of a', bOwn: null, durable: 'kept' },
        );
      } finally {
        try {
          await removeNamespace(namespace);
        } finally {
          await spawn('container', ['volume', 'delete', durable]);
        }
      }
    });

    it('runs readiness on every open, and a failed readiness rejects the open and leaves the container', async () => {
      const namespace = uniqueNamespace();
      const ready: string[] = [];
      let fail = false;
      const environment = new AppleContainerSandboxEnvironment({
        namespace,
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
        assert.strictEqual(await state(namespace, 'c'), 'running');
        const after = await second.run({ command: 'echo after' });
        assert.strictEqual(after.stdout, 'after\n');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('closes a handle once and rejects its operations with an error that names the chat, leaving the container running', async () => {
      const namespace = uniqueNamespace();
      const environment = new AppleContainerSandboxEnvironment({ namespace });
      try {
        await using sibling = await environment.open(chat('closed-chat'));
        const handle = await environment.open(chat('closed-chat'));
        await handle.close();
        await handle.close();
        await handle[Symbol.asyncDispose]();
        const fromSibling = await sibling.run({ command: 'echo sibling' });
        assert.strictEqual(fromSibling.stdout, 'sibling\n');

        assert.deepStrictEqual(
          await outcomes(handle),
          every('Error: The sandbox handle of chat "closed-chat" is closed.'),
        );
        assert.strictEqual(await state(namespace, 'closed-chat'), 'running');
      } finally {
        await removeNamespace(namespace);
      }
    });
  },
);
