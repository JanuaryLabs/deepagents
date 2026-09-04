import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import {
  type AgentModel,
  type AgentSandbox,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  AgentPluginCapability,
  type AgentPluginDefinition,
  type AgentPluginHost,
  AgentRuntime,
  type AgentRuntimeOptions,
  type SandboxContext,
  defineAgent,
  defineSandbox,
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

test('AgentRuntime rejects unknown agent plugin skill selections', () => {
  const agent = declaration();
  agent.skills = ['missing'];

  assert.throws(
    () => new AgentRuntime(agent, options),
    /agent "root" references unknown plugin skill "missing"/,
  );
});

test('AgentRuntime loads deterministic plugin-scoped agents before startup', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-plugin-agents-'),
  );
  await writeFile(join(directory.path, 'b.md'), agentDeclaration('b'));
  await writeFile(join(directory.path, 'a.md'), agentDeclaration('a'));
  await writeFile(
    join(directory.path, '.hidden.md'),
    agentDeclaration('hidden'),
  );
  await mkdir(join(directory.path, 'nested'));
  await writeFile(
    join(directory.path, 'nested', 'nested.md'),
    agentDeclaration('nested'),
  );
  await symlink(
    join(directory.path, 'a.md'),
    join(directory.path, 'linked.md'),
  );

  const runtime = new AgentRuntime(
    declaration([
      plugin('engineering', () => ({
        agents: [pathToFileURL(directory.path)],
      })),
    ]),
    options,
  );

  assert.deepEqual(
    runtime.info.agents.map(({ name, plugin }) => [name, plugin]),
    [
      ['root', undefined],
      ['engineering:a', 'engineering'],
      ['engineering:b', 'engineering'],
    ],
  );

  await writeFile(join(directory.path, 'c.md'), agentDeclaration('c'));
  assert.deepEqual(
    runtime.info.agents.map(({ name }) => name),
    ['root', 'engineering:a', 'engineering:b'],
  );
});

test('AgentRuntime rejects malformed and duplicate plugin agent declarations', async () => {
  await using malformed = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-plugin-agent-malformed-'),
  );
  await writeFile(
    join(malformed.path, 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviewer.\ntools: []\n---\n\nReview.\n',
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('engineering', () => ({ agents: [malformed.path] })),
        ]),
        options,
      ),
    /unknown frontmatter field "tools"/,
  );

  await using first = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-plugin-agent-first-'),
  );
  await using second = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-plugin-agent-second-'),
  );
  await writeFile(
    join(first.path, 'reviewer.md'),
    agentDeclaration('reviewer'),
  );
  await writeFile(
    join(second.path, 'reviewer.md'),
    agentDeclaration('reviewer'),
  );
  assert.throws(
    () =>
      new AgentRuntime(
        declaration([
          plugin('engineering', () => ({
            agents: [first.path, second.path],
          })),
        ]),
        options,
      ),
    /duplicate agent declaration name "engineering:reviewer"/,
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

test('host.sandbox attaches the configured root sandbox before the conversation exists', async () => {
  const hosts: AgentPluginHost[] = [];
  const contexts: SandboxContext[] = [];
  let configuredAttaches = 0;
  const capturing = plugin('capturing', () => ({
    configure: (root) => ({
      ...root,
      sandbox: (context) => {
        configuredAttaches++;
        return root.sandbox(context);
      },
    }),
    initialize: async (host) => {
      hosts.push(host);
    },
  }));
  const runtime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: defineSandbox(async (context) => {
        contexts.push(context);
        return createVirtualSandbox({ fs: new InMemoryFs() });
      }),
      instructions: [],
      plugins: [capturing],
    }),
    options,
  );
  await runtime.initialize();
  const [host] = hosts;
  assert.ok(host);

  const sandbox = await host.sandbox({ chatId: 'c1', userId: 'u1' });

  assert.equal(sandbox.workingDirectory, '/workspace');
  assert.deepEqual(contexts, [{ chatId: 'c1', userId: 'u1' }]);
  assert.equal(configuredAttaches, 1);
});

function agentDeclaration(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent.\n---\n\nInstructions for ${name}.\n`;
}
