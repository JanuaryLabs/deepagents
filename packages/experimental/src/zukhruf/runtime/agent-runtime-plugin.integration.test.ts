import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  AgentPluginCapability,
  type AgentPluginDefinition,
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
const options = {} as AgentRuntimeOptions;

function plugin<Instance extends object>(
  name: string,
  create: AgentPluginDefinition<Instance>['create'],
  capabilities?: AgentPluginDefinition<Instance>['capabilities'],
): AgentPluginDefinition<Instance> {
  return { name, create, ...(capabilities ? { capabilities } : {}) };
}

function declaration(
  plugins: readonly AgentPluginDefinition[] = [],
  tools = {},
) {
  return defineAgent({
    name: 'root',
    model: {} as AgentModel,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    tools,
    plugins,
  });
}

test('one exported definition materializes fresh bound plugin instances per runtime', () => {
  const value = new AgentPluginCapability<string>('test.value');
  const stateful = plugin(
    'stateful',
    (bindings) => ({ value: bindings.get(value), identity: {} }),
    [value],
  );
  const agent = declaration([stateful]);
  const first = new AgentRuntime(agent, {
    ...options,
    bindings: [value.bind('first')],
  });
  const second = new AgentRuntime(agent, {
    ...options,
    bindings: [value.bind('second')],
  });

  assert.notEqual(first.plugin(stateful), second.plugin(stateful));
  assert.notEqual(
    first.plugin(stateful).identity,
    second.plugin(stateful).identity,
  );
  assert.equal(first.plugin(stateful).value, 'first');
  assert.equal(second.plugin(stateful).value, 'second');
});

test('AgentRuntime validates capability bindings during construction', () => {
  const required = new AgentPluginCapability<string>('test.required');
  const unknown = new AgentPluginCapability<string>('test.unknown');
  const requiring = plugin(
    'requiring',
    (bindings) => ({ value: bindings.get(required) }),
    [required],
  );
  const agent = declaration([requiring]);

  assert.throws(
    () => new AgentRuntime(agent, options),
    /plugin "requiring" requires missing capability "test.required"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(agent, {
        ...options,
        bindings: [required.bind('one'), required.bind('two')],
      }),
    /duplicate binding for capability "test.required"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(agent, {
        ...options,
        bindings: [required.bind('value'), unknown.bind('unused')],
      }),
    /unused binding for capability "test.unknown"/,
  );
});

test('one binding may satisfy several plugins requiring one capability', () => {
  const shared = new AgentPluginCapability<object>('test.shared');
  const first = plugin(
    'first',
    (bindings) => ({ value: bindings.get(shared) }),
    [shared],
  );
  const second = plugin(
    'second',
    (bindings) => ({ value: bindings.get(shared) }),
    [shared],
  );
  const value = {};
  const runtime = new AgentRuntime(declaration([first, second]), {
    ...options,
    bindings: [shared.bind(value)],
  });

  assert.equal(runtime.plugin(first).value, value);
  assert.equal(runtime.plugin(second).value, value);
});

test('AgentRuntime rejects conflicting capability identities and undeclared access', () => {
  const first = new AgentPluginCapability<string>('test.same');
  const second = new AgentPluginCapability<string>('test.same');
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('first', () => ({}), [first]),
          plugin('second', () => ({}), [second]),
        ]),
        options,
      ),
    /capability "test.same" from plugin "second" conflicts with plugin "first"/,
  );

  const declared = new AgentPluginCapability<string>('test.declared');
  const undeclared = new AgentPluginCapability<string>('test.undeclared');
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin(
            'invalid',
            (bindings) => ({ value: bindings.get(undeclared) }),
            [declared],
          ),
        ]),
        { ...options, bindings: [declared.bind('value')] },
      ),
    /plugin "invalid" did not declare capability "test.undeclared"/,
  );
});

test('AgentRuntime validates names and tool collisions on materialized plugins', () => {
  assert.throws(
    () => new AgentRuntime(declaration([plugin('', () => ({}))]), options),
    /plugin name cannot be empty/,
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([plugin('same', () => ({})), plugin('same', () => ({}))]),
        options,
      ),
    /duplicate plugin name "same"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('one', () => ({ tools: { Echo: tool } })),
          plugin('two', () => ({ tools: { Echo: tool } })),
        ]),
        options,
      ),
    /plugin tool "Echo" from "two" conflicts with plugin "one"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([plugin('echo', () => ({ tools: { Echo: tool } }))], {
          Echo: tool,
        }),
        options,
      ),
    /tool "Echo" on agent "root" conflicts with plugin "echo"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('spawn', () => ({ tools: { spawn_agent: tool } })),
        ]),
        options,
      ),
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
      new AgentRuntime(
        declaration([
          plugin('one', () => ({ skills: [skillDirectory] })),
          plugin('two', () => ({ skills: [skillDirectory] })),
        ]),
        options,
      ),
    /duplicate plugin skill "duplicate"/,
  );
});

test('AgentRuntime rejects context collisions and subagent plugins', () => {
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('one', () => ({ runtimeContext: { shared: 1 } })),
          plugin('two', () => ({ runtimeContext: { shared: 2 } })),
        ]),
        options,
      ),
    /runtime context "shared" from plugin "two" conflicts with plugin "one"/,
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('reserved', () => ({ runtimeContext: { zukhruf: true } })),
        ]),
        options,
      ),
    /runtime context "zukhruf" from plugin "reserved" conflicts with the runtime/,
  );

  const child = defineAgent({
    name: 'child',
    model: {} as AgentModel,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    plugins: [plugin('child-plugin', () => ({}))],
  });
  assert.throws(
    () =>
      new AgentRuntime(
        defineAgent({
          name: 'root',
          model: {} as AgentModel,
          sandbox: async () => ({}) as AgentSandbox,
          instructions: [],
          subagents: [child],
        }),
        options,
      ),
    /subagent "child" cannot declare runtime plugins/,
  );
});
