import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  type ChatSandbox,
  MicrosandboxSandboxEnvironment,
  type SandboxContext,
} from '@deepagents/context';

import { every, outcomes } from './helpers/chat-sandbox-outcomes.ts';
import { isMicrosandboxUsable } from './helpers/microsandbox.ts';

const temporaryFiles = new TemporaryFiles();
const execFileAsync = promisify(execFile);

function chat(chatId: string): SandboxContext {
  return { chatId, userId: 'user-1' };
}

function uniqueNamespace(): string {
  return `test-${randomUUID()}`;
}

/** The VMs that carry the namespace's labels, and the chat's when given. */
async function chatVms(namespace: string, chatId?: string) {
  const { Sandbox } = await import('microsandbox');
  const page = await Sandbox.listWith((list) =>
    list.labels({
      'deepagents.sandbox.namespace': namespace,
      ...(chatId === undefined ? {} : { 'deepagents.sandbox.chat': chatId }),
    }),
  );
  return page.sandboxes;
}

/** The one VM of the chat, found by its labels. */
async function chatVm(namespace: string, chatId: string) {
  const [vm, ...others] = await chatVms(namespace, chatId);
  assert.ok(vm, `chat "${chatId}" must have a VM`);
  assert.deepStrictEqual(
    others.map(({ name }) => name),
    [],
    `chat "${chatId}" has one VM`,
  );
  return vm;
}

async function status(namespace: string, chatId: string) {
  return (await chatVm(namespace, chatId)).status;
}

/** Destroys every VM of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  const { SandboxNotFoundError: Gone } = await import('microsandbox');
  for (const vm of await chatVms(namespace)) {
    await vm.destroy().catch((error: unknown) => {
      if (!(error instanceof Gone)) throw error;
    });
  }
}

describe('MicrosandboxSandboxEnvironment', async () => {
  const usable = await isMicrosandboxUsable();
  if (!usable) {
    console.log(
      'Skipping microsandbox environment tests: runtime unavailable (requires the microsandbox package and Apple silicon or Linux with KVM)',
    );
  }

  describe('a chat handle', { skip: !usable }, () => {
    it('closes once and rejects its operations with an error that names the chat, leaving the VM running', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        await using sibling = await environment.open(chat('closed-chat'));
        const handle = await environment.open(chat('closed-chat'));
        await handle.close();
        await handle.close();
        await handle[Symbol.asyncDispose]();

        assert.deepStrictEqual(
          await outcomes(handle),
          every('Error: The sandbox handle of chat "closed-chat" is closed.'),
        );
        const fromSibling = await sibling.run({ command: 'echo sibling' });
        assert.strictEqual(fromSibling.stdout, 'sibling\n');
        assert.strictEqual(await status(namespace, 'closed-chat'), 'running');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('rejects every operation with SandboxNotFoundError once its chat is deleted, also after the chat is opened again', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
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

    it('rejects every operation, resume included, with SandboxNotFoundError when another VM took its name, instead of running in it', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        await using held = await environment.open(chat('c'));
        await held.writeTextFile({ path: 'held.txt', content: 'held' });
        const original = await chatVm(namespace, 'c');
        await original.destroy();
        // Platform setup no operation exposes: another VM takes the name.
        const { Sandbox } = await import('microsandbox');
        const replacement = await Sandbox.builder(original.name)
          .image('bash:5.3-alpine3.24')
          .ephemeral(false)
          .detached(true)
          .labels({
            'deepagents.sandbox.namespace': namespace,
            'deepagents.sandbox.chat': 'c',
          })
          .connectOrCreate();
        await replacement.detach();

        assert.deepStrictEqual(
          await outcomes(held),
          every('SandboxNotFoundError'),
        );
        await using reopened = await environment.open(chat('c'));
        assert.deepStrictEqual(
          {
            held: await reopened.readTextFile({ path: 'held.txt' }),
            note: await reopened.readTextFile({ path: 'note.txt' }),
          },
          { held: null, note: null },
          'no operation of the stale handle reached the replacement',
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it("keeps the chat's VM running under another handle's command when the handle that created it closes", async (t) => {
      const namespace = uniqueNamespace();
      const thisWorker = new MicrosandboxSandboxEnvironment({ namespace });
      const otherWorker = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        const creator = await thisWorker.open(chat('c'));
        await using sibling = await thisWorker.open(chat('c'));
        await using other = await otherWorker.open(chat('c'));

        const commands = [sibling, other].map((sandbox, index) =>
          sandbox.run({
            command: `touch started-${index}; sleep 2; echo done`,
          }),
        );
        await waitFor(
          async () =>
            assert.deepStrictEqual(
              await Promise.all(
                ['started-0', 'started-1'].map(async (path) =>
                  Boolean(await creator.stat({ path })),
                ),
              ),
              [true, true],
            ),
          { signal: t.signal },
        );
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
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('starts a VM stopped outside again with its files, through resume', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        await using held = await environment.open(chat('c'));
        await held.writeTextFile({ path: 'note.txt', content: 'kept' });
        await environment.stop(chat('c'));
        assert.strictEqual(await status(namespace, 'c'), 'stopped');

        await held.resume();
        assert.strictEqual(await status(namespace, 'c'), 'running');
        const read = await held.run({ command: 'cat note.txt' });
        assert.strictEqual(read.stdout, 'kept');
        await held.resume();
      } finally {
        await removeNamespace(namespace);
      }
    });
  });

  describe('the environment', { skip: !usable }, () => {
    it('opens one VM per chat that two handles share, found by its labels', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        await using writer = await environment.open(chat('c'));
        await using reader = await environment.open(chat('c'));
        await writer.writeTextFile({ path: 'note.txt', content: 'shared' });

        assert.strictEqual(
          await reader.readTextFile({ path: 'note.txt' }),
          'shared',
        );
        const vm = await chatVm(namespace, 'c');
        assert.strictEqual(vm.status, 'running');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('isolates chats from each other, and the same chat in another namespace', async () => {
      const namespace = uniqueNamespace();
      const otherNamespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      const otherEnvironment = new MicrosandboxSandboxEnvironment({
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
            ...(await chatVms(namespace)),
            ...(await chatVms(otherNamespace)),
          ].map(({ id }) => id),
        );
        assert.strictEqual(ids.size, 3);
      } finally {
        await removeNamespace(namespace);
        await removeNamespace(otherNamespace);
      }
    });

    it('stops the VM and keeps its files, so the next open starts it with them', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        const first = await environment.open(chat('c'));
        await first.writeTextFile({ path: 'note.txt', content: 'kept' });
        await first.close();

        await environment.stop(chat('c'));
        assert.strictEqual(await status(namespace, 'c'), 'stopped');
        await environment.stop(chat('c'));

        await using reopened = await environment.open(chat('c'));
        assert.strictEqual(
          await reopened.readTextFile({ path: 'note.txt' }),
          'kept',
        );
        assert.strictEqual(await status(namespace, 'c'), 'running');
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('keeps the VM and its files across a stop when configure marks it ephemeral', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        configure: (builder) => builder.ephemeral(true).detached(false),
      });
      try {
        const first = await environment.open(chat('c'));
        await first.writeTextFile({ path: 'note.txt', content: 'kept' });
        await first.close();
        await environment.stop(chat('c'));
        assert.strictEqual(await status(namespace, 'c'), 'stopped');

        await using reopened = await environment.open(chat('c'));
        assert.strictEqual(
          await reopened.readTextFile({ path: 'note.txt' }),
          'kept',
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('keeps commands and relative paths in its own workdir when it opens a VM created with another', async () => {
      const namespace = uniqueNamespace();
      const creator = new MicrosandboxSandboxEnvironment({
        namespace,
        workdir: '/srv/first',
      });
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        workdir: '/srv/second',
      });
      try {
        await (await creator.open(chat('c'))).close();
        await creator.stop(chat('c'));

        await using sandbox = await environment.open(chat('c'));
        await sandbox.writeTextFile({ path: 'here.txt', content: 'here' });
        const result = await sandbox.run({ command: 'pwd; cat here.txt' });

        assert.deepStrictEqual(result, {
          stdout: '/srv/second\nhere',
          stderr: '',
          exitCode: 0,
        });
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('stops and deletes without ever starting the VM, and resolves when there is none', async () => {
      const namespace = uniqueNamespace();
      await using mounted = await temporaryFiles.directory('msb-env-');
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        volumes: () => [
          {
            type: 'bind',
            hostPath: mounted.path,
            containerPath: '/mounted',
            readOnly: false,
          },
        ],
      });
      try {
        await environment.stop(chat('c'));
        await environment.delete(chat('c'));

        const handle = await environment.open(chat('c'));
        await handle.close();
        await environment.stop(chat('c'));
        // A stopped VM whose bind mount is gone fails to boot, so any start
        // that stop or delete made would reject.
        await mounted.cleanup();

        await environment.stop(chat('c'));
        assert.strictEqual(await status(namespace, 'c'), 'stopped');
        await environment.delete(chat('c'));
        await environment.delete(chat('c'));
        await environment.stop(chat('c'));

        assert.deepStrictEqual(await chatVms(namespace, 'c'), []);
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('deletes a running VM', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      const otherWorker = new MicrosandboxSandboxEnvironment({ namespace });
      try {
        await using running = await otherWorker.open(chat('c'));
        await environment.delete(chat('c'));
        assert.deepStrictEqual(await chatVms(namespace, 'c'), []);
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('makes one VM for concurrent opens of a chat', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({ namespace });
      const otherWorker = new MicrosandboxSandboxEnvironment({ namespace });
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

        for (const handle of rest) {
          assert.strictEqual(
            await handle.readTextFile({ path: 'note.txt' }),
            'one',
          );
        }
        await chatVm(namespace, 'c');
      } finally {
        for (const handle of handles) await handle.close();
        await removeNamespace(namespace);
      }
    });

    it('keeps the VM running with its files after the process that opened it exits', async () => {
      const namespace = uniqueNamespace();
      const program = `
        const { MicrosandboxSandboxEnvironment } = await import('@deepagents/context');
        const environment = new MicrosandboxSandboxEnvironment({ namespace: process.env.NAMESPACE });
        const sandbox = await environment.open({ chatId: 'c', userId: 'user-1' });
        await sandbox.writeTextFile({ path: 'note.txt', content: 'from the worker' });
        process.exit(0);
      `;
      try {
        await execFileAsync(
          process.execPath,
          ['--no-warnings', '--input-type=module', '--eval', program],
          {
            cwd: import.meta.dirname,
            env: { ...process.env, NAMESPACE: namespace },
          },
        );

        assert.strictEqual(await status(namespace, 'c'), 'running');
        const environment = new MicrosandboxSandboxEnvironment({ namespace });
        await using reopened = await environment.open(chat('c'));
        assert.strictEqual(
          await reopened.readTextFile({ path: 'note.txt' }),
          'from the worker',
        );
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('mounts the volumes the environment gives for each chat', async () => {
      const namespace = uniqueNamespace();
      const { Volume } = await import('microsandbox');
      await using files = await temporaryFiles.directory('msb-env-');
      const shared = `test-${randomUUID()}`;
      await Volume.builder(shared).create();
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        volumes: ({ chatId }) => [
          {
            type: 'bind',
            hostPath: `${files.path}/${chatId}`,
            containerPath: '/chat',
            readOnly: false,
          },
          {
            type: 'volume',
            name: shared,
            containerPath: '/shared',
            readOnly: false,
          },
          {
            type: 'bind',
            hostPath: files.path,
            containerPath: '/readonly',
          },
        ],
      });
      try {
        await mkdir(`${files.path}/a`);
        await mkdir(`${files.path}/b`);
        await using a = await environment.open(chat('a'));
        await using b = await environment.open(chat('b'));
        await a.writeTextFile({ path: '/chat/own.txt', content: 'of a' });
        await a.writeTextFile({ path: '/shared/all.txt', content: 'from a' });
        const readOnly = await a.run({ command: 'touch /readonly/x' });

        assert.deepStrictEqual(
          {
            host: await readFile(`${files.path}/a/own.txt`, 'utf8'),
            bOwn: await b.readTextFile({ path: '/chat/own.txt' }),
            bShared: await b.readTextFile({ path: '/shared/all.txt' }),
            readOnly: {
              refused: /Read-only file system/.test(readOnly.stderr),
              written: existsSync(`${files.path}/x`),
            },
          },
          {
            host: 'of a',
            bOwn: null,
            bShared: 'from a',
            readOnly: { refused: true, written: false },
          },
        );
      } finally {
        await removeNamespace(namespace);
        await Volume.remove(shared);
      }
    });

    it('rejects an open whose image has no Bash, naming the cause', async () => {
      const namespace = uniqueNamespace();
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        image: 'alpine',
      });
      try {
        await assert.rejects(environment.open(chat('c')), {
          name: 'MicrosandboxCreationError',
          message: /Bash is required/,
        });
      } finally {
        await removeNamespace(namespace);
      }
    });

    it('runs readiness on every open, and a failed readiness rejects the open and leaves the VM', async () => {
      const namespace = uniqueNamespace();
      const ready: string[] = [];
      let fail = false;
      const environment = new MicrosandboxSandboxEnvironment({
        namespace,
        readiness: async (sandbox) => {
          const { stdout } = await sandbox.run({ command: 'echo ready' });
          ready.push(stdout);
          if (fail) throw new Error('not ready');
        },
      });
      try {
        await using first = await environment.open(chat('c'));
        fail = true;
        await assert.rejects(environment.open(chat('c')), /not ready/);

        assert.deepStrictEqual(ready, ['ready\n', 'ready\n']);
        assert.strictEqual(await status(namespace, 'c'), 'running');
        const after = await first.run({ command: 'echo after' });
        assert.strictEqual(after.stdout, 'after\n');
      } finally {
        await removeNamespace(namespace);
      }
    });
  });
});
