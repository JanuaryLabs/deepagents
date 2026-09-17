import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
  type AgentStack,
  type SandboxContext,
  defineAgent,
  defineSandbox,
  defineStack,
  defineTool,
} from '@deepagents/experimental/zukhruf';

const tool = defineTool({
  description: 'Test tool.',
  inputSchema: z.object({}).strict(),
  execute: () => Promise.resolve({ ok: true }),
});
const options = {} as Awaited<ReturnType<AgentStack>>;
const stack = defineStack(async () => options);

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

test('one exported definition materializes fresh bound plugin instances per host', async () => {
  const value = new AgentPluginCapability<string>('test.value');
  const stateful = plugin(
    'stateful',
    (bindings) => ({ value: bindings.get(value), identity: {} }),
    [value],
  );
  const agent = declaration([stateful]);
  const firstSetup = new AgentRuntime(agent);
  const firstStack = defineStack(async () => ({
    ...options,
    bindings: [value.bind('first')],
  }));
  await using first = await firstSetup.initialize(firstStack);
  const secondSetup = new AgentRuntime(agent);
  const secondStack = defineStack(async () => ({
    ...options,
    bindings: [value.bind('second')],
  }));
  await using second = await secondSetup.initialize(secondStack);

  assert.notEqual(first.plugin(stateful), second.plugin(stateful));
  assert.notEqual(
    first.plugin(stateful).identity,
    second.plugin(stateful).identity,
  );
  assert.equal(first.plugin(stateful).value, 'first');
  assert.equal(second.plugin(stateful).value, 'second');
});

test('AgentRuntime validates capability bindings during initialization', async () => {
  const required = new AgentPluginCapability<string>('test.required');
  const unknown = new AgentPluginCapability<string>('test.unknown');
  const requiring = plugin(
    'requiring',
    (bindings) => ({ value: bindings.get(required) }),
    [required],
  );
  const agent = declaration([requiring]);

  const missingBindingRuntime = new AgentRuntime(agent);
  await assert.rejects(
    missingBindingRuntime.initialize(stack),
    /plugin "requiring" requires missing capability "test.required"/,
  );
  const duplicateBindingRuntime = new AgentRuntime(agent);
  const duplicateBindingRuntimeStack = defineStack(async () => ({
    ...options,
    bindings: [required.bind('one'), required.bind('two')],
  }));
  await assert.rejects(
    duplicateBindingRuntime.initialize(duplicateBindingRuntimeStack),
    /duplicate binding for capability "test.required"/,
  );
  const unusedBindingRuntime = new AgentRuntime(agent);
  const unusedBindingRuntimeStack = defineStack(async () => ({
    ...options,
    bindings: [required.bind('value'), unknown.bind('unused')],
  }));
  await assert.rejects(
    unusedBindingRuntime.initialize(unusedBindingRuntimeStack),
    /unused binding for capability "test.unknown"/,
  );
});

test('one binding may satisfy several plugins requiring one capability', async () => {
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
  const runtimeSetup = new AgentRuntime(declaration([first, second]));
  const stack = defineStack(async () => ({
    ...options,
    bindings: [shared.bind(value)],
  }));
  await using runtime = await runtimeSetup.initialize(stack);

  assert.equal(runtime.plugin(first).value, value);
  assert.equal(runtime.plugin(second).value, value);
});

test('missing bindings fail when their plugin is reached during initialization', async () => {
  const required = new AgentPluginCapability<string>('test.required');
  const created: string[] = [];
  const definitions = ['first', 'second', 'third'].map((name) =>
    plugin(
      name,
      () => {
        created.push(name);
        return {};
      },
      name === 'second' ? [required] : [],
    ),
  );
  const runtime = new AgentRuntime(declaration(definitions));
  await assert.rejects(
    runtime.initialize(stack),
    /plugin "second" requires missing capability "test.required"/,
  );
  assert.deepEqual(created, ['first']);
});

test('AgentRuntime rejects conflicting capability identities and undeclared access', async () => {
  const first = new AgentPluginCapability<string>('test.same');
  const second = new AgentPluginCapability<string>('test.same');
  const conflictingCapabilitiesRuntime = new AgentRuntime(
    declaration([
      plugin('first', () => ({}), [first]),
      plugin('second', () => ({}), [second]),
    ]),
  );
  await assert.rejects(
    conflictingCapabilitiesRuntime.initialize(stack),
    /capability "test.same" from plugin "second" conflicts with plugin "first"/,
  );

  const declared = new AgentPluginCapability<string>('test.declared');
  const undeclared = new AgentPluginCapability<string>('test.undeclared');
  const undeclaredCapabilityRuntime = new AgentRuntime(
    declaration([
      plugin('invalid', (bindings) => ({ value: bindings.get(undeclared) }), [
        declared,
      ]),
    ]),
  );
  const undeclaredCapabilityRuntimeStack = defineStack(async () => ({
    ...options,
    bindings: [declared.bind('value')],
  }));
  await assert.rejects(
    undeclaredCapabilityRuntime.initialize(undeclaredCapabilityRuntimeStack),
    /plugin "invalid" did not declare capability "test.undeclared"/,
  );
});

test('AgentRuntime validates names and tool collisions on materialized plugins', async () => {
  const emptyNameRuntime = new AgentRuntime(
    declaration([plugin('', () => ({}))]),
  );
  await assert.rejects(
    emptyNameRuntime.initialize(stack),
    /plugin name cannot be empty/,
  );
  const duplicateNamesRuntime = new AgentRuntime(
    declaration([plugin('same', () => ({})), plugin('same', () => ({}))]),
  );
  await assert.rejects(
    duplicateNamesRuntime.initialize(stack),
    /duplicate plugin name "same"/,
  );
  const conflictingToolsRuntime = new AgentRuntime(
    declaration([
      plugin('one', () => ({ tools: { Echo: tool } })),
      plugin('two', () => ({ tools: { Echo: tool } })),
    ]),
  );
  await assert.rejects(
    conflictingToolsRuntime.initialize(stack),
    /plugin tool "Echo" from "two" conflicts with plugin "one"/,
  );
  const localToolConflictRuntime = new AgentRuntime(
    declaration([plugin('echo', () => ({ tools: { Echo: tool } }))], {
      Echo: tool,
    }),
  );
  await assert.rejects(
    localToolConflictRuntime.initialize(stack),
    /tool "Echo" on agent "root" conflicts with plugin "echo"/,
  );
  const reservedToolConflictRuntime = new AgentRuntime(
    declaration([plugin('spawn', () => ({ tools: { spawn_agent: tool } }))]),
  );
  await assert.rejects(
    reservedToolConflictRuntime.initialize(stack),
    /plugin tool "spawn_agent" from "spawn" conflicts with the runtime/,
  );
});

test('static tool collisions fail before plugin configuration runs', async () => {
  let configured = false;
  const first = plugin('first', () => ({
    tools: { Echo: tool },
    configure(root) {
      configured = true;
      return root;
    },
  }));
  const second = plugin('second', () => ({ tools: { Echo: tool } }));
  const runtime = new AgentRuntime(declaration([first, second]));
  await assert.rejects(
    runtime.initialize(stack),
    /plugin tool "Echo" from "second" conflicts with plugin "first"/,
  );
  assert.equal(configured, false);
});

test('plugin configuration is ordered and cannot replace the root plugin composition', async () => {
  const events: string[] = [];
  const first = plugin('first', () => ({
    configure(root) {
      events.push('first');
      return { ...root, description: 'configured' };
    },
  }));
  const second = plugin('second', () => ({
    configure(root) {
      assert.equal(root.description, 'configured');
      events.push('second');
      return root;
    },
  }));
  const runtimeSetup = new AgentRuntime(declaration([first, second]));
  await using runtime = await runtimeSetup.initialize(stack);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(runtime.info.agents[0]?.description, 'configured');
  assert.throws(
    () => runtime.plugin(plugin('first', () => ({}))),
    /plugin "first" does not belong to this runtime/,
  );
  const replacing = plugin('replacing', () => ({
    configure: (root) => ({ ...root, plugins: [] }),
  }));
  const replacingRuntime = new AgentRuntime(declaration([replacing]));
  await assert.rejects(
    replacingRuntime.initialize(stack),
    /plugins cannot change the root plugin composition/,
  );
});

test('failed plugin workers close earlier workers while initialization resources remain owned', async () => {
  const events: string[] = [];
  const failing = new Error('worker startup failed');
  const definitions = ['first', 'second', 'third'].map((name) =>
    plugin(name, () => ({
      async initialize() {
        events.push(`${name}:initialize`);
        return {
          async [Symbol.asyncDispose]() {
            events.push(`${name}:dispose`);
          },
        };
      },
      async work() {
        events.push(`${name}:work`);
        if (name === 'second') throw failing;
        return {
          async [Symbol.asyncDispose]() {
            events.push(`${name}:stop`);
          },
        };
      },
    })),
  );
  const runtimeSetup = new AgentRuntime(declaration(definitions));
  await using runtime = await runtimeSetup.initialize(stack);
  await assert.rejects(runtime.work(), (error) => error === failing);
  assert.deepEqual(events, [
    'first:initialize',
    'second:initialize',
    'third:initialize',
    'first:work',
    'second:work',
    'first:stop',
  ]);
  await runtime[Symbol.asyncDispose]();
  assert.deepEqual(events.slice(6), [
    'third:dispose',
    'second:dispose',
    'first:dispose',
  ]);
});

test('code_mode is reserved only when code mode is enabled', async () => {
  const custom = plugin('custom', () => ({ tools: { code_mode: tool } }));
  const runtime = new AgentRuntime(declaration([custom]));
  await using host = await runtime.initialize(stack);
  const codeModeRuntime = new AgentRuntime(declaration([custom]));
  const codeModeRuntimeStack = defineStack(async () => ({
    ...options,
    multiAgent: { nonCodeModeOnly: false },
  }));
  await assert.rejects(
    codeModeRuntime.initialize(codeModeRuntimeStack),
    /plugin tool "code_mode" from "custom" conflicts with the runtime/,
  );
});

test('AgentRuntime rejects duplicate plugin skills during initialization', async () => {
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

  const duplicateSkillsRuntime = new AgentRuntime(
    declaration([
      plugin('one', () => ({ skills: [skillDirectory] })),
      plugin('two', () => ({ skills: [skillDirectory] })),
    ]),
  );
  await assert.rejects(
    duplicateSkillsRuntime.initialize(stack),
    /duplicate plugin skill "duplicate"/,
  );
});

test('AgentRuntime rejects unknown agent plugin skill selections', async () => {
  const agent = declaration();
  agent.skills = ['missing'];

  const runtime = new AgentRuntime(agent);
  await assert.rejects(
    runtime.initialize(stack),
    /agent "root" references unknown plugin skill "missing"/,
  );
});

test('skill composition collects directories before configure and loads their contents afterward', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-skill-order-'),
  );
  const skillDirectory = join(directory.path, 'assembled-skill');
  await mkdir(skillDirectory);
  const configured = plugin('configured', () => {
    const skills = [skillDirectory];
    return {
      skills,
      configure(root) {
        skills.push(join(directory.path, 'must-not-be-loaded'));
        writeFileSync(
          join(skillDirectory, 'SKILL.md'),
          '---\nname: assembled-skill\ndescription: Assembled during configuration.\n---\n\nUse this skill.\n',
        );
        return { ...root, skills: ['assembled-skill'] };
      },
    };
  });
  const runtime = new AgentRuntime(declaration([configured]));
  await using host = await runtime.initialize(stack);
});

test('agent composition reads configured sources and validates the graph before skill loading', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'zukhruf-agent-order-'),
  );
  await writeFile(
    join(directory.path, 'reviewer.md'),
    agentDeclaration('reviewer'),
  );
  const configured = plugin('engineering', () => {
    const agents: string[] = [];
    return {
      agents,
      configure(root) {
        agents.push(directory.path);
        return root;
      },
    };
  });
  const runtimeSetup = new AgentRuntime(declaration([configured]));
  await using runtime = await runtimeSetup.initialize(stack);
  assert.deepEqual(
    runtime.info.agents.map(({ name }) => name),
    ['root', 'engineering:reviewer'],
  );
  const missingSkills = plugin('skills', () => ({
    skills: [join(directory.path, 'missing-skill')],
  }));
  const conflictingAgentsRuntime = new AgentRuntime(
    defineAgent({
      ...declaration([configured, missingSkills]),
      subagents: [
        defineAgent({ ...declaration(), name: 'engineering:reviewer' }),
      ],
    }),
  );
  await assert.rejects(
    conflictingAgentsRuntime.initialize(stack),
    /duplicate agent declaration name "engineering:reviewer"/,
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

  const runtimeSetup = new AgentRuntime(
    declaration([
      plugin('engineering', () => ({
        agents: [pathToFileURL(directory.path)],
      })),
    ]),
  );
  await using runtime = await runtimeSetup.initialize(stack);

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
  const malformedAgentsRuntime = new AgentRuntime(
    declaration([plugin('engineering', () => ({ agents: [malformed.path] }))]),
  );
  await assert.rejects(
    malformedAgentsRuntime.initialize(stack),
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
  const duplicateAgentsRuntime = new AgentRuntime(
    declaration([
      plugin('engineering', () => ({
        agents: [first.path, second.path],
      })),
    ]),
  );
  await assert.rejects(
    duplicateAgentsRuntime.initialize(stack),
    /duplicate agent declaration name "engineering:reviewer"/,
  );
});

test('AgentRuntime rejects context collisions and subagent plugins', async () => {
  const conflictingContextRuntime = new AgentRuntime(
    declaration([
      plugin('one', () => ({ runtimeContext: { shared: 1 } })),
      plugin('two', () => ({ runtimeContext: { shared: 2 } })),
    ]),
  );
  await assert.rejects(
    conflictingContextRuntime.initialize(stack),
    /runtime context "shared" from plugin "two" conflicts with plugin "one"/,
  );
  const reservedContextRuntime = new AgentRuntime(
    declaration([
      plugin('reserved', () => ({ runtimeContext: { zukhruf: true } })),
    ]),
  );
  await assert.rejects(
    reservedContextRuntime.initialize(stack),
    /runtime context "zukhruf" from plugin "reserved" conflicts with the runtime/,
  );

  const child = defineAgent({
    name: 'child',
    model: {} as AgentModel,
    sandbox: async () => ({}) as AgentSandbox,
    instructions: [],
    plugins: [plugin('child-plugin', () => ({}))],
  });
  const childPluginsRuntime = new AgentRuntime(
    defineAgent({
      name: 'root',
      model: {} as AgentModel,
      sandbox: async () => ({}) as AgentSandbox,
      instructions: [],
      subagents: [child],
    }),
  );
  await assert.rejects(
    childPluginsRuntime.initialize(stack),
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
  );
  await using ready = await runtime.initialize(stack);
  const [host] = hosts;
  assert.ok(host);

  const sandbox = await host.sandbox({ chatId: 'c1', userId: 'u1' });

  assert.equal(sandbox.workingDirectory, '/workspace');
  assert.deepEqual(contexts, [{ chatId: 'c1', userId: 'u1' }]);
  assert.equal(configuredAttaches, 1);
});

test('each initialization creates an independent host with its own plugin resources', async () => {
  const gate = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const events: string[] = [];
  const asynchronous = plugin('async', () => ({
    async initialize() {
      events.push('connect');
      if (events.length === 2) connected.resolve();
      await gate.promise;
      return {
        tools: { Echo: tool },
        async [Symbol.asyncDispose]() {
          events.push('close');
        },
      };
    },
  }));
  const runtime = new AgentRuntime(declaration([asynchronous]));
  const firstInitializing = runtime.initialize(stack);
  const secondInitializing = runtime.initialize(stack);
  assert.notEqual(firstInitializing, secondInitializing);
  await connected.promise;
  assert.deepEqual(events, ['connect', 'connect']);
  gate.resolve();
  const first = await firstInitializing;
  const second = await secondInitializing;
  await Promise.all([
    first[Symbol.asyncDispose](),
    second[Symbol.asyncDispose](),
  ]);
  assert.deepEqual(events, ['connect', 'connect', 'close', 'close']);
});

test('later initialization failures dispose acquired resources in reverse order', async () => {
  const closed: string[] = [];
  const acquired = (name: string) =>
    plugin(name, () => ({
      async initialize() {
        return {
          async [Symbol.asyncDispose]() {
            closed.push(name);
          },
        };
      },
    }));
  const failing = plugin('fail', () => ({
    async initialize() {
      throw new Error('startup failed');
    },
  }));
  const runtime = new AgentRuntime(
    declaration([acquired('one'), acquired('two'), failing]),
  );
  await assert.rejects(runtime.initialize(stack), /startup failed/);
  assert.deepEqual(closed, ['two', 'one']);
});

test('asynchronously discovered tools retain every collision boundary', async (t) => {
  for (const conflict of [
    'static plugin',
    'async plugin',
    'runtime',
    'root',
    'child',
  ]) {
    await t.test(conflict, async () => {
      let closed = 0;
      const name = conflict === 'runtime' ? 'spawn_agent' : 'Echo';
      const discovered = plugin('discovered', () => ({
        async initialize() {
          return {
            tools: { [name]: tool },
            async [Symbol.asyncDispose]() {
              closed++;
            },
          };
        },
      }));
      const plugins: AgentPluginDefinition[] = [discovered];
      if (conflict === 'static plugin') {
        plugins.unshift(plugin('existing', () => ({ tools: { Echo: tool } })));
      }
      if (conflict === 'async plugin') {
        plugins.unshift(
          plugin('existing', () => ({
            async initialize() {
              return {
                tools: { Echo: tool },
                async [Symbol.asyncDispose]() {},
              };
            },
          })),
        );
      }
      const root = declaration(
        plugins,
        conflict === 'root' ? { Echo: tool } : {},
      );
      if (conflict === 'child') {
        root.subagents = [
          defineAgent({ ...declaration([], { Echo: tool }), name: 'child' }),
        ];
      }
      const runtime = new AgentRuntime(root);
      await assert.rejects(runtime.initialize(stack), /conflicts with/);
      assert.equal(closed, 1);
    });
  }
});

test('a discovered tool collision stops later initialization and rolls back resources', async () => {
  const events: string[] = [];
  const discovered = (name: string) =>
    plugin(name, () => ({
      async initialize() {
        events.push(`${name}:initialize`);
        return {
          tools: { Echo: tool },
          async [Symbol.asyncDispose]() {
            events.push(`${name}:close`);
          },
        };
      },
    }));
  const runtime = new AgentRuntime(
    declaration([
      discovered('first'),
      discovered('second'),
      discovered('third'),
    ]),
  );
  const initialization = runtime.initialize(stack);
  await assert.rejects(
    initialization,
    /plugin tool "Echo" from "second" conflicts with plugin "first"/,
  );
  assert.deepEqual(events, [
    'first:initialize',
    'second:initialize',
    'second:close',
    'first:close',
  ]);
});

test('different agents may share local tool names before and after discovery', async () => {
  const discovered = plugin('discovered', () => ({
    async initialize() {
      return { tools: { Shared: tool }, async [Symbol.asyncDispose]() {} };
    },
  }));
  const runtimeSetup = new AgentRuntime(
    defineAgent({
      ...declaration([discovered], { Echo: tool }),
      subagents: [
        defineAgent({ ...declaration([], { Echo: tool }), name: 'child' }),
      ],
    }),
  );
  await using runtime = await runtimeSetup.initialize(stack);
});

function agentDeclaration(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent.\n---\n\nInstructions for ${name}.\n`;
}
