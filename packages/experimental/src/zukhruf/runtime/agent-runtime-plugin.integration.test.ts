import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  AgentRuntime,
  type AgentRuntimeOptions,
  defineAgent,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const tool = defineTool({
  description: 'Test tool.',
  inputSchema: z.object({}).strict(),
  execute: () => Promise.resolve({ ok: true }),
});

function declaration(tools = {}) {
  return defineAgent({
    name: 'root',
    model: {} as AgentModel,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    tools,
  });
}

const options = {} as AgentRuntimeOptions;

test('AgentRuntime requires unique non-empty plugin names', () => {
  assert.throws(
    () =>
      new AgentRuntime(declaration(), { ...options, plugins: [{ name: '' }] }),
    /plugin name cannot be empty/,
  );
  assert.throws(
    () =>
      new AgentRuntime(declaration(), {
        ...options,
        plugins: [{ name: 'same' }, { name: 'same' }],
      }),
    /duplicate plugin name "same"/,
  );
});

test('AgentRuntime rejects plugin tool collisions during construction', () => {
  assert.throws(
    () =>
      new AgentRuntime(declaration(), {
        ...options,
        plugins: [
          { name: 'one', tools: { Echo: tool } },
          { name: 'two', tools: { Echo: tool } },
        ],
      }),
    /plugin tool "Echo" from "two" conflicts with plugin "one"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(declaration({ Echo: tool }), {
        ...options,
        plugins: [{ name: 'echo', tools: { Echo: tool } }],
      }),
    /tool "Echo" on agent "root" conflicts with plugin "echo"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(declaration(), {
        ...options,
        plugins: [{ name: 'spawn', tools: { spawn_agent: tool } }],
      }),
    /plugin tool "spawn_agent" from "spawn" conflicts with the runtime/,
  );
});

test('AgentRuntime rejects duplicate plugin skills during construction', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-plugin-skill-'),
  );
  const skillDirectory = join(directory.path, 'duplicate');
  await mkdir(skillDirectory);
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    ['---', 'name: duplicate', 'description: Duplicate skill.', '---'].join(
      '\n',
    ),
  );

  assert.throws(
    () =>
      new AgentRuntime(declaration(), {
        ...options,
        plugins: [
          { name: 'one', skills: [skillDirectory] },
          { name: 'two', skills: [skillDirectory] },
        ],
      }),
    /duplicate plugin skill "duplicate"/,
  );
});
