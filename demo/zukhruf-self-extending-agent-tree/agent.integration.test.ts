import { PGlite } from '@electric-sql/pglite';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PgBoss, fromPglite } from 'pg-boss';

import {
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createVirtualSandbox,
} from '@deepagents/context';
import declaration from '@deepagents/demo-zukhruf-self-extending-agent-tree';
import {
  AgentRuntime,
  PgBossTurnQueue,
  SqliteMailboxStore,
  defineSandbox,
  defineStack,
} from '@deepagents/experimental/zukhruf';

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
} as const;

test('authors a missing skill before a fresh general task agent uses it', async () => {
  await using backend = await createVirtualSandbox({ fs: new InMemoryFs() });
  const sandbox = defineSandbox(async () => backend, {
    destination: '/agent',
  });

  let rootCalls = 0;
  const rootModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      rootCalls++;
      switch (rootCalls) {
        case 1:
          assert.match(
            JSON.stringify(prompt),
            /Build a TypeScript API with Hono/,
          );
          return toolResponse('bash', 'inspect-skill-catalog', {
            command:
              'find skills -mindepth 2 -maxdepth 2 -name SKILL.md -print 2>/dev/null || true',
            reasoning: 'Check the current shared skill catalog.',
          });
        case 2:
          return toolResponse('spawn_agent', 'author-hono', {
            agent_type: 'skill-authority',
            task_name: 'author-hono',
            message:
              'Create and publish a reusable hono skill for building TypeScript HTTP APIs.',
            fork_turns: 'none',
          });
        case 3:
          return toolResponse('wait_agent', 'wait-for-hono-skill', {
            timeout_ms: 10_000,
          });
        case 4:
          assert.match(JSON.stringify(prompt), /Published skill/);
          return toolResponse('spawn_agent', 'implement-hono-api', {
            agent_type: 'general-task',
            task_name: 'implement-hono-api',
            message: 'Build the requested TypeScript API. Use the hono skill.',
            fork_turns: 'all',
          });
        case 5:
          return toolResponse('wait_agent', 'wait-for-implementation', {
            timeout_ms: 10_000,
          });
        default:
          assert.match(
            JSON.stringify(prompt),
            /Built the API using the hono skill/,
          );
          return textResponse(
            'Built the API using the newly published hono skill.',
          );
      }
    },
  });

  let skillAuthorityCalls = 0;
  const skillAuthorityModel = new MockLanguageModelV4({
    doStream: async () => {
      skillAuthorityCalls++;
      if (skillAuthorityCalls === 1) {
        return toolResponse('bash', 'publish-hono-skill', {
          command:
            "mkdir -p skills/.hono.tmp && printf '%s\\n' '---' 'name: hono' 'description: Build TypeScript HTTP APIs with Hono.' '---' '' '# Hono' '' 'Use Hono routing conventions and typed bindings.' > skills/.hono.tmp/SKILL.md && grep -qx 'name: hono' skills/.hono.tmp/SKILL.md && grep -q '^description: .' skills/.hono.tmp/SKILL.md && mv skills/.hono.tmp skills/hono",
          reasoning:
            'Publish the validated skill atomically to the shared catalog.',
        });
      }
      return textResponse('Published skill "hono".');
    },
  });

  let generalTaskCalls = 0;
  const generalTaskModel = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      generalTaskCalls++;
      const serializedPrompt = JSON.stringify(prompt);
      if (generalTaskCalls === 1) {
        assert.match(serializedPrompt, /Build TypeScript HTTP APIs with Hono/);
        assert.match(serializedPrompt, /skills\/hono\/SKILL\.md/);
        return toolResponse('bash', 'read-hono-skill', {
          command:
            "cat skills/hono/SKILL.md && printf '%s\\n' 'export default {}' > workspace/server.ts",
          reasoning:
            'Read the named skill, then implement the task in the shared workspace.',
        });
      }
      assert.match(serializedPrompt, /Use Hono routing conventions/);
      return textResponse('Built the API using the hono skill.');
    },
  });

  const [skillAuthority, generalTask] = declaration.subagents;
  const root = {
    ...declaration,
    model: rootModel,
    sandbox,
    subagents: [
      { ...skillAuthority, model: skillAuthorityModel, sandbox },
      { ...generalTask, model: generalTaskModel, sandbox },
    ],
  };

  await using resources = new AsyncDisposableStack();
  const database = resources.adopt(new PGlite(), (database) =>
    database.close(),
  );
  const boss = resources.adopt(
    new PgBoss({ db: fromPglite(database), backend: 'pglite' }),
    (boss) => boss.stop({ graceful: false }),
  );
  boss.on('error', () => {});
  await boss.start();
  const queue = new PgBossTurnQueue(boss, {
    pollingIntervalSeconds: 0.5,
    schema: 'pgboss',
  });
  await queue.initialize();
  const streamStore = resources.adopt(
    new SqliteStreamStore(':memory:'),
    (store) => store.close(),
  );
  const runtime = new AgentRuntime(root);
  const stack = defineStack(async () => ({
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue,
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  }));
  const host = resources.use(await runtime.initialize(stack));
  resources.use(await host.work({ concurrency: 4 }));

  const turn = await host.enqueue(
    { chatId: 'root-chat', userId: 'user-1' },
    {
      message: {
        id: 'user-message',
        role: 'user',
        parts: [{ type: 'text', text: 'Build a TypeScript API with Hono.' }],
      },
      trigger: 'submit-message',
    },
  );
  let answer = '';
  for await (const chunk of turn.stream) {
    if (chunk.type === 'text-delta') answer += chunk.delta;
  }

  assert.equal(answer, 'Built the API using the newly published hono skill.');
  assert.equal(rootCalls, 6);
  assert.equal(skillAuthorityCalls, 2);
  assert.equal(generalTaskCalls, 2);
  assert.match(
    await backend.readFile('/agent/skills/hono/SKILL.md'),
    /^name: hono$/m,
  );
  assert.equal(
    await backend.readFile('/agent/workspace/server.ts'),
    'export default {}\n',
  );
});

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}

function toolResponse(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: '' },
          usage,
        },
      ],
    }),
  };
}
