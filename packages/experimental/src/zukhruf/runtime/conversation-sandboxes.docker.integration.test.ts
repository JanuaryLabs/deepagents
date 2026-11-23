import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { DockerTestbed } from '@zukhruf/testing/docker';
import type { UIMessageChunk } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DockerSandboxEnvironment,
  type StoppableSandboxEnvironment,
} from '@deepagents/context';
import {
  type AgentPluginHost,
  AgentRuntime,
  EmbeddedAgentStorage,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import {
  textResult,
  toolCallResult,
} from '../../testing/stream-results.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const testbed = new DockerTestbed({ environment: process.env });
const defaults = await testbed.defaults();

/** A chat environment of its own namespace, as one worker process builds it. */
function chatEnvironment(namespace: string) {
  return new DockerSandboxEnvironment({ namespace, container: defaults });
}

/** Runs the next of `commands` in the chat's container on each turn, then answers. */
function bashEachTurn(...commands: string[]) {
  const pending = [...commands];
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      if (prompt.at(-1)?.role === 'tool') return textResult('done');
      const command = pending.shift();
      assert.ok(command, 'the test scripts a command for every turn');
      return toolCallResult({
        toolCallId: crypto.randomUUID(),
        toolName: 'bash',
        input: JSON.stringify({ command, reasoning: 'the scripted command' }),
      });
    },
  });
}

/** The bash tool's settled output in a turn's stream. */
async function bashOutput(turn: { stream: ReadableStream<UIMessageChunk> }) {
  for (const chunk of await Array.fromAsync(turn.stream)) {
    if (chunk.type === 'tool-output-available') {
      return { type: chunk.type, output: chunk.output, errorText: undefined };
    }
    if (chunk.type === 'tool-output-error') {
      return {
        type: chunk.type,
        output: undefined,
        errorText: chunk.errorText,
      };
    }
  }
  return undefined;
}

/** The containers that carry the chat's labels. */
async function chatContainers(namespace: string) {
  const client = await testbed.client();
  return client.containers.list({
    all: true,
    filters: { label: [`deepagents.sandbox.namespace=${namespace}`] },
  });
}

/** The one container of the namespace's chat, found by its labels. */
async function chatContainer(namespace: string) {
  const [summary, ...others] = await chatContainers(namespace);
  assert.ok(summary?.Id, 'the chat has a container');
  assert.deepStrictEqual(others, [], 'the chat has one container');
  const found = await (await testbed.client()).containers.find(summary.Id);
  assert.ok(found, `container ${summary.Id} exists`);
  return found;
}

/** Removes every container of the test's namespace, by its label. */
async function removeNamespace(namespace: string): Promise<void> {
  const client = await testbed.client();
  for (const { Id } of await chatContainers(namespace)) {
    if (Id === undefined) continue;
    const container = await client.containers.find(Id);
    await container?.unpause().catch(() => undefined);
    await container?.remove({ force: true });
  }
}

const bashSucceeded = (stdout: string) => ({
  type: 'tool-output-available',
  output: { stdout, stderr: '', exitCode: 0 },
  errorText: undefined,
});

test('a chat whose container was removed between turns runs its next turn in a new container', async () => {
  const namespace = `removed-${crypto.randomUUID()}`;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const root = defineAgent({
      name: 'root',
      model: bashEachTurn('hostname', 'hostname'),
      instructions: [],
      sandbox: defineSandbox(chatEnvironment(namespace), {
        idleTimeoutMs: false,
      }),
    });
    await using host = await new AgentRuntime(root).initialize(
      defineStack(async (resources) => ({
        storage: resources.use(
          await EmbeddedAgentStorage.open({ directory: directory.path }),
        ),
      })),
    );
    await host.work();
    const conversation = { chatId: 'chat', userId: 'owner' };

    const first = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const removed = await chatContainer(namespace);
    await removed.remove({ force: true });
    const second = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-2', 'second')),
    );

    const replacement = await chatContainer(namespace);
    assert.deepEqual(
      [first, second],
      [removed.id, replacement.id].map((id) =>
        bashSucceeded(`${id.slice(0, 12)}\n`),
      ),
    );
    assert.notEqual(replacement.id, removed.id);
  } finally {
    await removeNamespace(namespace);
  }
});

test('a chat whose container was stopped between turns runs its next turn in that container, started again with its files', async () => {
  const namespace = `stopped-${crypto.randomUUID()}`;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const environment = chatEnvironment(namespace);
    const root = defineAgent({
      name: 'root',
      model: bashEachTurn(
        'echo kept > note.txt && hostname',
        'cat note.txt && hostname',
      ),
      instructions: [],
      sandbox: defineSandbox(environment, { idleTimeoutMs: false }),
    });
    await using host = await new AgentRuntime(root).initialize(
      defineStack(async (resources) => ({
        storage: resources.use(
          await EmbeddedAgentStorage.open({ directory: directory.path }),
        ),
      })),
    );
    await host.work();
    const conversation = { chatId: 'chat', userId: 'owner' };

    const first = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const container = await chatContainer(namespace);
    await environment.stop(conversation);
    const stopped = (await container.inspect()).State?.Status;
    const second = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-2', 'second')),
    );

    const hostname = `${container.id.slice(0, 12)}\n`;
    assert.deepStrictEqual(
      {
        stopped,
        turns: [first, second],
        container: (await chatContainer(namespace)).id,
        status: (await container.inspect()).State?.Status,
      },
      {
        stopped: 'exited',
        turns: [bashSucceeded(hostname), bashSucceeded(`kept\n${hostname}`)],
        container: container.id,
        status: 'running',
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

test("a worker that created the chat's container shuts down while another worker's turn runs a command in it, and the command finishes in the running container", async (t) => {
  const namespace = `shutdown-${crypto.randomUUID()}`;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    await using storage = await EmbeddedAgentStorage.open({
      directory: directory.path,
    });
    // Each worker builds its own declaration and environment, as each
    // process does; both borrow the one storage.
    const worker = (...commands: string[]) =>
      new AgentRuntime(
        defineAgent({
          name: 'root',
          model: bashEachTurn(...commands),
          instructions: [],
          sandbox: defineSandbox(chatEnvironment(namespace), {
            idleTimeoutMs: false,
          }),
        }),
      ).initialize(defineStack(async () => ({ storage })));
    const conversation = { chatId: 'chat', userId: 'owner' };

    await using other = await worker(
      'touch /tmp/started && sleep 3 && echo done && hostname',
    );
    let created: string;
    let running: ReturnType<typeof bashOutput>;
    {
      await using creator = await worker('hostname');
      {
        await using working = await creator.work();
        void working;
        await bashOutput(
          await creator.enqueue(conversation, userTurn('turn-1', 'first')),
        );
      }
      const container = await chatContainer(namespace);
      created = container.id;

      await other.work();
      running = bashOutput(
        await other.enqueue(conversation, userTurn('turn-2', 'second')),
      );
      await waitFor(
        async () => assert.ok(await container.stat('/tmp/started')),
        { signal: t.signal },
      );
    }

    const container = await chatContainer(namespace);
    assert.deepStrictEqual(
      {
        turn: await running,
        container: container.id,
        status: (await container.inspect()).State?.Status,
      },
      {
        turn: bashSucceeded(`done\n${created.slice(0, 12)}\n`),
        container: created,
        status: 'running',
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

/** The runtime's plugin host, reached as a plugin reaches it. */
async function chatRuntime(
  directory: string,
  environment: StoppableSandboxEnvironment,
) {
  const hosts: AgentPluginHost[] = [];
  const root = defineAgent({
    name: 'root',
    model: bashEachTurn('hostname'),
    instructions: [],
    sandbox: defineSandbox(environment, { idleTimeoutMs: false }),
    plugins: [
      {
        name: 'host',
        create: () => ({
          initialize: async (host: AgentPluginHost) => {
            hosts.push(host);
          },
        }),
      },
    ],
  });
  const runtime = await new AgentRuntime(root).initialize(
    defineStack(async (resources) => ({
      storage: resources.use(await EmbeddedAgentStorage.open({ directory })),
    })),
  );
  const [plugins] = hosts;
  assert.ok(plugins);
  return { runtime, plugins };
}

test('two callers that find the container removed share one new container', async () => {
  const namespace = `shared-${crypto.randomUUID()}`;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const { runtime, plugins } = await chatRuntime(
      directory.path,
      chatEnvironment(namespace),
    );
    await using host = runtime;
    await host.work();
    const conversation = { chatId: 'chat', userId: 'owner' };
    await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const removed = await chatContainer(namespace);
    await removed.remove({ force: true });

    const [first, second] = await Promise.all([
      plugins.sandbox(conversation),
      plugins.sandbox(conversation),
    ]);

    const containers = await chatContainers(namespace);
    const ran = await first.sandbox.run({ command: 'hostname' });
    assert.deepStrictEqual(
      {
        sameSandbox: first.sandbox === second.sandbox,
        containers: containers.length,
        replaced: containers[0]?.Id !== removed.id,
        hostname: { stdout: ran.stdout, exitCode: ran.exitCode },
      },
      {
        sameSandbox: true,
        containers: 1,
        replaced: true,
        hostname: {
          stdout: `${containers[0]?.Id?.slice(0, 12)}\n`,
          exitCode: 0,
        },
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

test('a caller whose check of the removed container ends after another caller closed its handle shares the new container', async () => {
  const namespace = `overlap-${crypto.randomUUID()}`;
  let containerRemoved = false;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const environment = chatEnvironment(namespace);
    const { runtime, plugins } = await chatRuntime(directory.path, {
      open: async (chat) => {
        const sandbox = await environment.open(chat);
        const removable = !containerRemoved;
        const released = Promise.withResolvers<void>();
        const { resume, close } = sandbox;
        let checks = 0;
        const closed = async () => {
          await close();
          released.resolve();
        };
        return Object.assign(sandbox, {
          // A second check of the removed container ends after its handle
          // closed, as a check still in flight on a closing handle does.
          resume: async () => {
            if (removable && containerRemoved && ++checks === 2) {
              await released.promise;
            }
            return resume();
          },
          close: closed,
          [Symbol.asyncDispose]: closed,
        });
      },
      stop: (chat) => environment.stop(chat),
      delete: (chat) => environment.delete(chat),
    });
    await using host = runtime;
    await host.work();
    const conversation = { chatId: 'chat', userId: 'owner' };
    await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const removed = await chatContainer(namespace);
    await removed.remove({ force: true });
    containerRemoved = true;

    const [first, second] = await Promise.all([
      plugins.sandbox(conversation),
      plugins.sandbox(conversation),
    ]);

    const containers = await chatContainers(namespace);
    const ran = await second.sandbox.run({ command: 'hostname' });
    assert.deepStrictEqual(
      {
        sameSandbox: first.sandbox === second.sandbox,
        containers: containers.length,
        replaced: containers[0]?.Id !== removed.id,
        hostname: { stdout: ran.stdout, exitCode: ran.exitCode },
      },
      {
        sameSandbox: true,
        containers: 1,
        replaced: true,
        hostname: {
          stdout: `${containers[0]?.Id?.slice(0, 12)}\n`,
          exitCode: 0,
        },
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});

test('a chat whose container is paused keeps its handle and that container, unpaused for the next command', async () => {
  const namespace = `paused-${crypto.randomUUID()}`;
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const { runtime, plugins } = await chatRuntime(
      directory.path,
      chatEnvironment(namespace),
    );
    await using host = runtime;
    await host.work();
    const conversation = { chatId: 'chat', userId: 'owner' };
    await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const before = await plugins.sandbox(conversation);
    const paused = await chatContainer(namespace);
    await paused.pause();

    const after = await plugins.sandbox(conversation);

    const ran = await after.sandbox.run({ command: 'true' });
    assert.deepStrictEqual(
      {
        sameSandbox: after.sandbox === before.sandbox,
        container: (await chatContainer(namespace)).id,
        check: { exitCode: ran.exitCode, stderr: ran.stderr },
      },
      {
        sameSandbox: true,
        container: paused.id,
        check: { exitCode: 0, stderr: '' },
      },
    );
  } finally {
    await removeNamespace(namespace);
  }
});
