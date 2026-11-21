import { TemporaryFiles } from '@zukhruf/fs';
import { DockerTestbed } from '@zukhruf/testing/docker';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDockerSandbox } from '@deepagents/context';
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
const defaults = { container: await testbed.defaults() };

/** Runs `hostname` in the chat's container on each turn, then answers. */
function hostnameEveryTurn() {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) =>
      prompt.at(-1)?.role === 'tool'
        ? textResult('done')
        : toolCallResult({
            toolCallId: crypto.randomUUID(),
            toolName: 'bash',
            input: JSON.stringify({
              command: 'hostname',
              reasoning: 'which container',
            }),
          }),
  });
}

/** The bash tool's settled output in a turn's stream. */
async function bashOutput(turn: { stream: ReadableStream<unknown> }) {
  const chunks = (await Array.fromAsync(turn.stream)) as {
    type: string;
    output?: unknown;
    errorText?: string;
  }[];
  return chunks.find(
    ({ type }) =>
      type === 'tool-output-available' || type === 'tool-output-error',
  );
}

test('a chat whose container was removed between turns runs its next turn in a new container of the same name', async () => {
  const chatId = `removed-${crypto.randomUUID()}`;
  const name = `sandbox-${chatId}`;
  const client = await testbed.client();
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const root = defineAgent({
      name: 'root',
      model: hostnameEveryTurn(),
      instructions: [],
      sandbox: defineSandbox(() =>
        createDockerSandbox({ ...defaults, name: chatId }),
      ),
    });
    await using host = await new AgentRuntime(root).initialize(
      defineStack(async (resources) => ({
        storage: resources.use(
          await EmbeddedAgentStorage.open({ directory: directory.path }),
        ),
      })),
    );
    await host.work();
    const conversation = { chatId, userId: 'owner' };

    const first = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const removed = await client.containers.find(name);
    assert.ok(removed);
    await removed.remove({ force: true });
    const second = await bashOutput(
      await host.enqueue(conversation, userTurn('turn-2', 'second')),
    );

    const replacement = await client.containers.find(name);
    assert.deepEqual(
      [first, second].map((chunk) => ({
        type: chunk?.type,
        output: chunk?.output,
        errorText: chunk?.errorText,
      })),
      [removed.id, replacement?.id].map((id) => ({
        type: 'tool-output-available',
        output: { stdout: `${id?.slice(0, 12)}\n`, stderr: '', exitCode: 0 },
        errorText: undefined,
      })),
    );
    assert.notEqual(replacement?.id, removed.id);
  } finally {
    await (await client.containers.find(name))?.remove({ force: true });
  }
});

/** The runtime's plugin host, reached as a plugin reaches it. */
async function chatRuntime(directory: string, chatId: string) {
  const hosts: AgentPluginHost[] = [];
  const root = defineAgent({
    name: 'root',
    model: hostnameEveryTurn(),
    instructions: [],
    sandbox: defineSandbox(() =>
      createDockerSandbox({ ...defaults, name: chatId }),
    ),
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
  const chatId = `shared-${crypto.randomUUID()}`;
  const name = `sandbox-${chatId}`;
  const client = await testbed.client();
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const { runtime, plugins } = await chatRuntime(directory.path, chatId);
    await using host = runtime;
    await host.work();
    const conversation = { chatId, userId: 'owner' };
    await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const removed = await client.containers.find(name);
    assert.ok(removed);
    await removed.remove({ force: true });

    const [first, second] = await Promise.all([
      plugins.sandbox(conversation),
      plugins.sandbox(conversation),
    ]);

    const named = await client.containers.list({
      all: true,
      filters: { name: [`^/${name}$`] },
    });
    const ran = await first.sandbox.run({ command: 'hostname' });
    assert.deepStrictEqual(
      {
        sameSandbox: first.sandbox === second.sandbox,
        containers: named.length,
        replaced: named[0]?.Id !== removed.id,
        hostname: { stdout: ran.stdout, exitCode: ran.exitCode },
      },
      {
        sameSandbox: true,
        containers: 1,
        replaced: true,
        hostname: { stdout: `${named[0]?.Id?.slice(0, 12)}\n`, exitCode: 0 },
      },
    );
  } finally {
    await (await client.containers.find(name))?.remove({ force: true });
  }
});

test('a chat whose container is paused keeps its handle and that container: a failed check that is not removal replaces nothing', async () => {
  const chatId = `paused-${crypto.randomUUID()}`;
  const name = `sandbox-${chatId}`;
  const client = await testbed.client();
  try {
    await using directory = await new TemporaryFiles().directory('zukhruf-');
    const { runtime, plugins } = await chatRuntime(directory.path, chatId);
    await using host = runtime;
    await host.work();
    const conversation = { chatId, userId: 'owner' };
    await bashOutput(
      await host.enqueue(conversation, userTurn('turn-1', 'first')),
    );
    const before = await plugins.sandbox(conversation);
    const paused = await client.containers.find(name);
    assert.ok(paused);
    await paused.pause();

    const after = await plugins.sandbox(conversation);

    const ran = await after.sandbox.run({ command: 'true' });
    const kept = await client.containers.find(name);
    assert.deepStrictEqual(
      {
        sameSandbox: after.sandbox === before.sandbox,
        container: kept?.id,
        check: { exitCode: ran.exitCode, stderr: ran.stderr },
      },
      {
        sameSandbox: true,
        container: paused.id,
        check: {
          exitCode: 1,
          stderr: `Container ${paused.id} is paused, unpause the container before exec`,
        },
      },
    );
  } finally {
    const container = await client.containers.find(name);
    await container?.unpause().catch(() => undefined);
    await container?.remove({ force: true });
  }
});
