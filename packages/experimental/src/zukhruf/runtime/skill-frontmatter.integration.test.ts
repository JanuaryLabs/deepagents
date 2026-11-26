import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { PGlite } from '@electric-sql/pglite';
import { open } from '@zukhruf/sqlite-open';
import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  SqliteContextStore,
  SqliteStreamStore,
  VirtualSandboxEnvironment,
} from '@deepagents/context';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineAgent,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { ControlledAgentStorage } from '../../testing/controlled-agent-storage.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { usage } from '../../testing/usage.fixture.ts';
import { userTurn } from '../../testing/user-turn.fixture.ts';

const stack = defineStack(async (resources) => {
  const database = resources.use(new PGlite());
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', (error) => {
    throw error;
  });
  await boss.start();
  const store = new SqliteStreamStore(resources.use(open(':memory:')));
  return {
    storage: new ControlledAgentStorage({
      queue: await PgBossTurnQueue.create(boss, {
        pollingIntervalSeconds: 0.5,
        schema: 'pgboss',
      }),
      store: new SqliteContextStore(resources.use(open(':memory:'))),
      streams: streamsFor(store),
      mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
    }),
  };
});

test('a sandbox skill whose description holds an unquoted colon is listed for the turn', async () => {
  const prompts: LanguageModelV4Prompt[] = [];
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        stream: ReadableStream.from([
          { type: 'text-start' as const, id: 'text' },
          { type: 'text-delta' as const, id: 'text', delta: 'ok' },
          { type: 'text-end' as const, id: 'text' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage,
          },
        ]),
      };
    },
  });
  const environment = new VirtualSandboxEnvironment();
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'deployer',
      model,
      instructions: [],
      sandbox: defineSandbox({
        open: async (chat) => {
          const backend = await environment.open(chat);
          await backend.writeTextFile({
            path: '/workspace/skills/aws/SKILL.md',
            content:
              '---\nname: aws\ndescription: Build for AWS: ECS\n---\n\n# AWS\n',
          });
          return backend;
        },
        delete: (chat) => environment.delete(chat),
      }),
    }),
  );
  await using host = await runtime.initialize(stack);
  await host.work();

  const turn = await host.enqueue(
    { chatId: 'aws', userId: 'owner' },
    userTurn('deploy', 'Deploy the service.'),
  );
  await Array.fromAsync(turn.stream);

  assert.ok(prompts[0]);
  const system = prompts[0]
    .flatMap((message) => (message.role === 'system' ? [message.content] : []))
    .join('\n');
  const [, catalog = ''] = system.split('### Available skills\n');
  assert.deepEqual(catalog.split('\n### How to use skills\n')[0].split('\n'), [
    '- aws: Build for AWS: ECS (file: skills/aws/SKILL.md)',
  ]);
});
