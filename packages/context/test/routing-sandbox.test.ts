import type { CommandResult, Sandbox } from 'bash-tool';
import {
  InMemoryFs,
  type TransformContext,
  type TransformPlugin,
  type TransformResult,
  type WordNode,
} from 'just-bash';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  type ExtensionCommand,
  type SandboxExtension,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  isInstallable,
} from '@deepagents/context';

import {
  createShallowBackend,
  recordingBackend,
} from './helpers/shallow-backend.ts';

const echoExt = (
  cmdName: string,
  body: (args: string[], sandbox: Sandbox) => Promise<CommandResult>,
): SandboxExtension => ({
  commands: [
    {
      name: cmdName,
      handler: async (args, ctx) => body(args, ctx.sandbox),
    },
  ],
});

describe('createVirtualSandbox + createRoutingSandbox: basic bash', () => {
  it('runs plain bash commands with empty extensions', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [],
    });

    const result = await sandbox.executeCommand('echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
  });
});

describe('createRoutingSandbox: deep dispatch (virtual backend)', () => {
  it('dispatches a single extension command', async () => {
    const ext = echoExt('hi', async (args) => ({
      stdout: `hi:${args.join(',')}\n`,
      stderr: '',
      exitCode: 0,
    }));

    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    const result = await sandbox.executeCommand('hi a b');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hi:a,b\n');
  });
});

describe('createRoutingSandbox: shallow dispatch (non-installable backend)', () => {
  it('dispatches top-level extension command', async () => {
    const ext = echoExt('hi', async (args) => ({
      stdout: `hi:${args.join(',')}\n`,
      stderr: '',
      exitCode: 0,
    }));
    const sandbox = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [ext],
    });

    const result = await sandbox.executeCommand('hi a b');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'hi:a,b\n');
  });

  it('forwards non-matching top-level command to backend verbatim', async () => {
    const { sandbox: backend, calls } = recordingBackend(
      await createShallowBackend(),
    );
    const ext = echoExt('never', async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    const result = await sandbox.executeCommand('echo hello');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
    assert.deepStrictEqual(calls, ['echo hello']);
  });

  it('forwards pipelines to backend as a single string (no dispatch)', async () => {
    const { sandbox: backend, calls } = recordingBackend(
      await createShallowBackend(),
    );
    let handlerCalled = false;
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'marker',
          handler: async () => {
            handlerCalled = true;
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      ],
    };
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    await sandbox.executeCommand('echo x | cat');
    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0], /echo x/);
    assert.match(calls[0], /cat/);
  });

  it('pipeline with a matching first token still forwards to backend', async () => {
    const { sandbox: backend, calls } = recordingBackend(
      await createShallowBackend(),
    );
    let handlerCalled = false;
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'marker',
          handler: async () => {
            handlerCalled = true;
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      ],
    };
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    await sandbox.executeCommand('marker x | cat');
    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(calls.length, 1);
  });
});

describe('createRoutingSandbox: host handlers via ctx.sandbox', () => {
  it('handler writeFiles followed by readFile returns the content (virtual)', async () => {
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'xwrite',
          handler: async (args, ctx) => {
            await ctx.sandbox.writeFiles([{ path: args[0], content: args[1] }]);
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          },
        },
        {
          name: 'xread',
          handler: async (args, ctx) => {
            const content = await ctx.sandbox.readFile(args[0]);
            return { stdout: content, stderr: '', exitCode: 0 };
          },
        },
      ],
    };
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    const w = await sandbox.executeCommand('xwrite /tmp/x.txt hi');
    assert.strictEqual(w.exitCode, 0, w.stderr);
    const r = await sandbox.executeCommand('xread /tmp/x.txt');
    assert.strictEqual(r.exitCode, 0, r.stderr);
    assert.strictEqual(r.stdout, 'hi');
  });

  it('handler writeFiles followed by readFile returns the content (shallow)', async () => {
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'xwrite',
          handler: async (args, ctx) => {
            await ctx.sandbox.writeFiles([{ path: args[0], content: args[1] }]);
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          },
        },
        {
          name: 'xread',
          handler: async (args, ctx) => {
            const content = await ctx.sandbox.readFile(args[0]);
            return { stdout: content, stderr: '', exitCode: 0 };
          },
        },
      ],
    };
    const sandbox = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [ext],
    });

    await sandbox.executeCommand('xwrite /tmp/x.txt hi');
    const r = await sandbox.executeCommand('xread /tmp/x.txt');
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.stdout, 'hi');
  });
});

describe('createVirtualSandbox: install semantics', () => {
  it('install() called twice throws', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    assert.ok(isInstallable(backend));
    await backend.install({
      commands: [],
      plugins: [],
      env: {},
    });
    await assert.rejects(
      async () => backend.install({ commands: [], plugins: [], env: {} }),
      /install-once/,
    );
  });

  it('executeCommand before install throws', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    await assert.rejects(
      backend.executeCommand('echo x'),
      /executeCommand called before install/,
    );
  });

  it('readFile before install throws', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    await assert.rejects(
      backend.readFile('/x'),
      /readFile called before install/,
    );
  });

  it('writeFiles before install throws', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    await assert.rejects(
      backend.writeFiles([{ path: '/x', content: 'a' }]),
      /writeFiles called before install/,
    );
  });
});

describe('createRoutingSandbox: plugins', () => {
  const appendArgPlugin = (token: string): TransformPlugin => ({
    name: `append-${token}`,
    transform: (ctx: TransformContext): TransformResult => {
      const cmd = ctx.ast.statements[0]?.pipelines[0]?.commands[0];
      if (cmd && cmd.type === 'SimpleCommand') {
        const wordNode: WordNode = {
          type: 'Word',
          parts: [{ type: 'Literal', value: token }],
        };
        cmd.args.push(wordNode);
      }
      return { ast: ctx.ast };
    },
  });

  it('plugins run in declared order on shallow dispatch', async () => {
    const { sandbox: backend, calls } = recordingBackend(
      await createShallowBackend(),
    );
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [
        { plugins: [appendArgPlugin('alpha')] },
        { plugins: [appendArgPlugin('beta')] },
      ],
    });

    await sandbox.executeCommand('ls');
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0], /^ls\s+alpha\s+beta$/);
  });
});

describe('createBashTool: skills upload still works via routing sandbox', () => {
  it('copies skill files into the sandbox', async () => {
    const host = mkdtempSync(join(tmpdir(), 'routing-sandbox-skills-'));
    const skillDir = join(host, 'hello');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: hello\ndescription: Say hello\n---\nbody',
    );

    const sandbox = await createBashTool({
      sandbox: await createRoutingSandbox({
        backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
        hostExtensions: [],
      }),
      skills: [{ host, sandbox: '/workspace/skills' }],
    });

    const content = await sandbox.sandbox.readFile(
      '/workspace/skills/hello/SKILL.md',
    );
    assert.match(content, /name: hello/);
    assert.strictEqual(sandbox.skills.length, 1);
  });
});

describe('createRoutingSandbox: onBeforeBashCall', () => {
  it('chains pre-call hooks across extensions', async () => {
    const { sandbox: backend, calls } = recordingBackend(
      await createShallowBackend(),
    );
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [
        { onBeforeBashCall: ({ command }) => ({ command: command + ' a' }) },
        { onBeforeBashCall: ({ command }) => ({ command: command + ' b' }) },
      ],
    });

    await sandbox.executeCommand('echo');
    assert.strictEqual(calls[0], 'echo a b');
  });

  it('chains pre-call hooks on deep dispatch (virtual backend)', async () => {
    const ext1: SandboxExtension = {
      onBeforeBashCall: ({ command }) => ({ command: command + ' step1' }),
    };
    const ext2: SandboxExtension = {
      commands: [
        {
          name: 'echo2',
          handler: async (args) => ({
            stdout: `${args.join(' ')}\n`,
            stderr: '',
            exitCode: 0,
          }),
        },
      ],
      onBeforeBashCall: ({ command }) => ({ command: command + ' step2' }),
    };
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext1, ext2],
    });

    const result = await sandbox.executeCommand('echo2 start');
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /start step1 step2/);
  });
});

describe('createBashTool: sql extension smoke', () => {
  it('dispatches sql run through extensions option', async () => {
    const calls: string[] = [];
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'sql',
          handler: async (args, ctx) => {
            const sub = args[0] ?? 'missing';
            const query = args.slice(1).join(' ');
            calls.push(`${sub}:${query}`);
            await ctx.sandbox.executeCommand('mkdir -p /sql');
            await ctx.sandbox.writeFiles([
              { path: '/sql/out.json', content: '[]' },
            ]);
            return {
              stdout: 'results stored in /sql/out.json\n',
              stderr: '',
              exitCode: 0,
            };
          },
        },
      ],
    };
    const sandbox = await createBashTool({
      sandbox: await createRoutingSandbox({
        backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
        hostExtensions: [ext],
      }),
    });

    const result = await sandbox.sandbox.executeCommand('sql run "SELECT 1"');
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /results stored in/);
    assert.deepStrictEqual(calls, ['run:SELECT 1']);
  });
});

describe('createRoutingSandbox: cwd option', () => {
  it('threads cwd to shallow handler ctx', async () => {
    let captured = '';
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'wherex',
          handler: async (_args, ctx) => {
            captured = ctx.cwd;
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          },
        },
      ],
    };

    const sandbox = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [ext],
      cwd: '/workspace',
    });

    await sandbox.executeCommand('wherex');
    assert.strictEqual(captured, '/workspace');
  });

  it('defaults shallow cwd to / when omitted', async () => {
    let captured = '';
    const ext: SandboxExtension = {
      commands: [
        {
          name: 'wherex2',
          handler: async (_args, ctx) => {
            captured = ctx.cwd;
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          },
        },
      ],
    };

    const sandbox = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [ext],
    });

    await sandbox.executeCommand('wherex2');
    assert.strictEqual(captured, '/');
  });
});

describe('createRoutingSandbox: parse error handling on shallow', () => {
  const identityPlugin: TransformPlugin = {
    name: 'identity',
    transform: (ctx: TransformContext): TransformResult => ({ ast: ctx.ast }),
  };

  it('returns parse error when transformer cannot parse the command', async () => {
    const sandbox = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [{ plugins: [identityPlugin] }],
    });

    const result = await sandbox.executeCommand('echo "unterminated');
    assert.strictEqual(result.exitCode, 2);
    assert.match(result.stderr, /parse error/);
  });
});

describe('createRoutingSandbox: class-based backend survives routing', () => {
  class ClassBackend implements Sandbox {
    #files = new Map<string, string>();

    async executeCommand(command: string): Promise<CommandResult> {
      if (/^mkdir -p \S+$/.test(command.trim())) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: this.#files.size.toString(), stderr: '', exitCode: 0 };
    }

    async readFile(path: string): Promise<string> {
      const v = this.#files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    }

    async writeFiles(files: Array<{ path: string; content: string | Buffer }>) {
      for (const f of files) {
        this.#files.set(
          f.path,
          typeof f.content === 'string'
            ? f.content
            : f.content.toString('utf-8'),
        );
      }
    }
  }

  it('preserves readFile when backend methods live on prototype', async () => {
    const backend = new ClassBackend();
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [],
    });

    await sandbox.writeFiles([{ path: '/tmp/cls.txt', content: 'hello' }]);
    const content = await sandbox.readFile('/tmp/cls.txt');
    assert.strictEqual(content, 'hello');
  });

  it('preserves readFile when pre-call hook is attached', async () => {
    const backend = new ClassBackend();
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [{ onBeforeBashCall: ({ command }) => ({ command }) }],
    });

    await sandbox.writeFiles([{ path: '/tmp/cls2.txt', content: 'world' }]);
    const content = await sandbox.readFile('/tmp/cls2.txt');
    assert.strictEqual(content, 'world');
  });
});

describe('createRoutingSandbox: extension env on deep dispatch', () => {
  it('exposes merged.env to host handler ctx on virtual backend', async () => {
    let captured: Record<string, string> | null = null;
    const ext: SandboxExtension = {
      env: { MY_FLAG: '1' },
      commands: [
        {
          name: 'capture',
          handler: async (_args, ctx) => {
            captured = ctx.env;
            return { stdout: 'ok\n', stderr: '', exitCode: 0 };
          },
        },
      ],
    };

    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [ext],
    });

    const result = await sandbox.executeCommand('capture');
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(captured!.MY_FLAG, '1');
  });

  it('exposes merged.env to the shell on virtual backend', async () => {
    const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const sandbox = await createRoutingSandbox({
      backend,
      hostExtensions: [{ env: { MY_FLAG: '42' } }],
    });

    const result = await sandbox.executeCommand('echo "$MY_FLAG"');
    assert.strictEqual(result.exitCode, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), '42');
  });
});

describe('ExtensionCommand type shape', () => {
  it('is a portable interface independent of just-bash', () => {
    const cmd: ExtensionCommand = {
      name: 'x',
      handler: () => ({ stdout: '', stderr: '', exitCode: 0 }),
    };
    assert.strictEqual(cmd.name, 'x');
  });
});
