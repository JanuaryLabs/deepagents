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

test('missing bindings fail when their plugin is reached during construction', () => {
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
  assert.throws(
    () => new AgentRuntime(declaration(definitions), options),
    /plugin "second" requires missing capability "test.required"/,
  );
  assert.deepEqual(created, ['first']);
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

test('static tool collisions fail before plugin configuration runs', () => {
  let configured = false;
  const first = plugin('first', () => ({
    tools: { Echo: tool },
    configure(root) {
      configured = true;
      return root;
    },
  }));
  const second = plugin('second', () => ({ tools: { Echo: tool } }));
  assert.throws(
    () => new AgentRuntime(declaration([first, second]), options),
    /plugin tool "Echo" from "second" conflicts with plugin "first"/,
  );
  assert.equal(configured, false);
});

test('plugin configuration is ordered and cannot replace the root plugin composition', () => {
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
  const runtime = new AgentRuntime(declaration([first, second]), options);
  assert.deepEqual(events, ['first', 'second']);
  assert.equal(runtime.info.agents[0]?.description, 'configured');
  assert.throws(
    () => runtime.plugin(plugin('first', () => ({}))),
    /plugin "first" does not belong to this runtime/,
  );
  const replacing = plugin('replacing', () => ({
    configure: (root) => ({ ...root, plugins: [] }),
  }));
  assert.throws(
    () => new AgentRuntime(declaration([replacing]), options),
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
  await using runtime = new AgentRuntime(declaration(definitions), options);
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

test('code_mode is reserved only when code mode is enabled', () => {
  const custom = plugin('custom', () => ({ tools: { code_mode: tool } }));
  assert.doesNotThrow(() => new AgentRuntime(declaration([custom]), options));
  assert.throws(
    () =>
      new AgentRuntime(declaration([custom]), {
        ...options,
        multiAgent: { nonCodeModeOnly: false },
      }),
    /plugin tool "code_mode" from "custom" conflicts with the runtime/,
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
  assert.doesNotThrow(
    () => new AgentRuntime(declaration([configured]), options),
  );
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
  const runtime = new AgentRuntime(declaration([configured]), options);
  assert.deepEqual(
    runtime.info.agents.map(({ name }) => name),
    ['root', 'engineering:reviewer'],
  );
  const missingSkills = plugin('skills', () => ({
    skills: [join(directory.path, 'missing-skill')],
  }));
  assert.throws(
    () =>
      new AgentRuntime(
        defineAgent({
          ...declaration([configured, missingSkills]),
          subagents: [
            defineAgent({ ...declaration(), name: 'engineering:reviewer' }),
          ],
        }),
        options,
      ),
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

test('asynchronous initialization is shared and runtime disposal waits for it', async () => {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  const asynchronous = plugin('async', () => ({
    async initialize() {
      events.push('connect');
      await gate.promise;
      return {
        tools: { Echo: tool },
        async [Symbol.asyncDispose]() {
          events.push('close');
        },
      };
    },
  }));
  const runtime = new AgentRuntime(declaration([asynchronous]), options);
  const initialized = runtime.initialize();
  assert.equal(runtime.initialize(), initialized);
  const disposed = runtime[Symbol.asyncDispose]();
  assert.equal(runtime[Symbol.asyncDispose](), disposed);
  await assert.rejects(runtime.initialize(), /runtime is disposed/);
  assert.deepEqual(events, ['connect']);
  gate.resolve();
  await Promise.all([initialized, disposed]);
  assert.deepEqual(events, ['connect', 'close']);
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
  await using runtime = new AgentRuntime(
    declaration([acquired('one'), acquired('two'), failing]),
    options,
  );
  await assert.rejects(runtime.initialize(), /startup failed/);
  assert.deepEqual(closed, ['two', 'one']);
  await runtime[Symbol.asyncDispose]();
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
      await using runtime = new AgentRuntime(root, options);
      await assert.rejects(runtime.initialize(), /conflicts with/);
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
  await using runtime = new AgentRuntime(
    declaration([
      discovered('first'),
      discovered('second'),
      discovered('third'),
    ]),
    options,
  );
  const initialization = runtime.initialize();
  await assert.rejects(
    initialization,
    /plugin tool "Echo" from "second" conflicts with plugin "first"/,
  );
  assert.equal(runtime.initialize(), initialization);
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
  await using runtime = new AgentRuntime(
    defineAgent({
      ...declaration([discovered], { Echo: tool }),
      subagents: [
        defineAgent({ ...declaration([], { Echo: tool }), name: 'child' }),
      ],
    }),
    options,
  );
  await runtime.initialize();
});

function agentDeclaration(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent.\n---\n\nInstructions for ${name}.\n`;
}
