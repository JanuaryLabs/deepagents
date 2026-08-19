import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  type AgentRuntimeOptions,
  defineAgent,
} from '@deepagents/experimental/zukhruf';
import { fileAgents } from '@deepagents/experimental/zukhruf/file-agents';

const model = { provider: 'test', modelId: 'test-model' } as AgentModel;
const sandbox = async () => ({}) as AgentSandbox;
const root = defineAgent({
  name: 'root',
  description: 'Coordinates specialists.',
  model,
  sandbox,
  instructions: [],
  tools: { root_tool: {} as never },
  telemetry: { isEnabled: true },
  subagents: [
    defineAgent({
      name: 'code-defined',
      model,
      sandbox,
      instructions: [],
    }),
  ],
});

test('fileAgents plugin adds one deterministic startup snapshot through AgentRuntime plugins', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-file-agents-'),
  );
  writeFileSync(
    join(directory.path, 'b.md'),
    declaration('b', 'Second agent.'),
  );
  writeFileSync(join(directory.path, 'a.md'), declaration('a', 'First agent.'));
  writeFileSync(
    join(directory.path, '.hidden.md'),
    declaration('hidden', 'Hidden.'),
  );
  writeFileSync(join(directory.path, 'notes.txt'), 'not an agent');
  mkdirSync(join(directory.path, 'nested'));
  writeFileSync(
    join(directory.path, 'nested', 'nested.md'),
    declaration('nested', 'Nested.'),
  );
  symlinkSync(join(directory.path, 'a.md'), join(directory.path, 'linked.md'));

  let configured: AgentDeclaration | undefined;
  const runtime = new AgentRuntime(root, {
    ...({} as AgentRuntimeOptions),
    plugins: [
      fileAgents({ directory: directory.path }),
      {
        configure(declaration) {
          configured = declaration;
          return declaration;
        },
      },
    ],
  });

  assert.deepEqual(
    configured?.subagents?.map(({ name }) => name),
    ['code-defined', 'a', 'b'],
  );
  for (const agent of configured?.subagents?.slice(1) ?? []) {
    assert.equal(agent.model, model);
    assert.equal(agent.sandbox, sandbox);
    assert.equal(agent.tools, undefined);
    assert.equal(agent.telemetry, undefined);
  }
  assert.deepEqual(
    runtime.info.agents.map(({ name, description }) => [name, description]),
    [
      ['root', 'Coordinates specialists.'],
      ['code-defined', undefined],
      ['a', 'First agent.'],
      ['b', 'Second agent.'],
    ],
  );

  writeFileSync(
    join(directory.path, 'later.md'),
    declaration('later', 'Later.'),
  );
  assert.equal(
    runtime.info.agents.some(({ name }) => name === 'later'),
    false,
  );
});

test('fileAgents rejects an invalid catalog before AgentRuntime construction', async () => {
  const cases = [
    {
      fileName: 'agent.md',
      content: `---\nname: agent\ndescription: Agent.\ntools: []\n---\nWork.`,
      expected: /unknown frontmatter field "tools"/,
    },
    {
      fileName: 'wrong.md',
      content: declaration('agent', 'Agent.'),
      expected: /frontmatter name must match the filename/,
    },
    {
      fileName: 'agent.md',
      content: `---\nname: agent\ndescription: Agent.\n---\n`,
      expected: /instructions cannot be empty/,
    },
  ];

  for (const { fileName, content, expected } of cases) {
    await using directory = await mkdtempDisposable(
      join(tmpdir(), 'zukhruf-file-agents-'),
    );
    writeFileSync(join(directory.path, fileName), content);
    assert.throws(
      () =>
        new AgentRuntime(root, {
          ...({} as AgentRuntimeOptions),
          plugins: [fileAgents({ directory: directory.path })],
        }),
      expected,
    );
  }
});

test('fileAgents accepts an empty directory and leaves duplicate validation to AgentRuntime', async () => {
  await using empty = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-file-agents-empty-'),
  );
  await using duplicate = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-file-agents-duplicate-'),
  );
  writeFileSync(
    join(duplicate.path, 'code-defined.md'),
    declaration('code-defined', 'Duplicate.'),
  );

  const runtime = new AgentRuntime(root, {
    ...({} as AgentRuntimeOptions),
    plugins: [fileAgents({ directory: pathToFileURL(empty.path) })],
  });
  assert.deepEqual(
    runtime.info.agents.map(({ name }) => name),
    ['root', 'code-defined'],
  );
  assert.throws(
    () =>
      new AgentRuntime(root, {
        ...({} as AgentRuntimeOptions),
        plugins: [fileAgents({ directory: duplicate.path })],
      }),
    /duplicate agent declaration name "code-defined"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(root, {
        ...({} as AgentRuntimeOptions),
        plugins: [fileAgents({ directory: join(empty.path, 'missing') })],
      }),
    /ENOENT/,
  );
});

function declaration(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`;
}
