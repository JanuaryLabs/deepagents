import type { CommandResult, Sandbox } from 'bash-tool';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type SandboxExtension,
  createRoutingSandbox,
  createVirtualSandbox,
} from '@deepagents/context';

import { createShallowBackend } from './helpers/shallow-backend.ts';

function fooExt(): SandboxExtension {
  return {
    commands: [
      {
        name: 'foo',
        handler: async (args) => ({
          stdout: `foo:${args.join('|')}\n`,
          stderr: '',
          exitCode: 0,
        }),
      },
      {
        name: 'writeread',
        handler: async (args, ctx) => {
          const [path, value] = args;
          await ctx.sandbox.writeFiles([{ path, content: value }]);
          const read = await ctx.sandbox.readFile(path);
          return { stdout: read, stderr: '', exitCode: 0 };
        },
      },
    ],
  };
}

async function buildVirtual(): Promise<Sandbox> {
  const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
  return createRoutingSandbox({
    backend,
    hostExtensions: [fooExt()],
  });
}

async function buildShallow(): Promise<Sandbox> {
  return createRoutingSandbox({
    backend: await createShallowBackend(),
    hostExtensions: [fooExt()],
  });
}

function assertParity(
  label: string,
  virtual: CommandResult,
  shallow: CommandResult,
) {
  assert.deepStrictEqual(
    {
      stdout: shallow.stdout,
      stderr: shallow.stderr,
      exitCode: shallow.exitCode,
    },
    {
      stdout: virtual.stdout,
      stderr: virtual.stderr,
      exitCode: virtual.exitCode,
    },
    `parity mismatch for: ${label}`,
  );
}

describe('routing-sandbox parity: virtual vs shallow', () => {
  it('top-level command with no args', async () => {
    const v = await (await buildVirtual()).executeCommand('foo');
    const s = await (await buildShallow()).executeCommand('foo');
    assertParity('foo', v, s);
  });

  it('top-level command with one quoted arg', async () => {
    const v = await (await buildVirtual()).executeCommand('foo "hello world"');
    const s = await (await buildShallow()).executeCommand('foo "hello world"');
    assertParity('foo "hello world"', v, s);
  });

  it('top-level command with multi-arg quoted', async () => {
    const v = await (await buildVirtual()).executeCommand('foo a "b c" d');
    const s = await (await buildShallow()).executeCommand('foo a "b c" d');
    assertParity('foo a "b c" d', v, s);
  });

  it('host handler writeFiles + readFile round-trip', async () => {
    const v = await (
      await buildVirtual()
    ).executeCommand('writeread /tmp/parity.txt hello');
    const s = await (
      await buildShallow()
    ).executeCommand('writeread /tmp/parity.txt hello');
    assertParity('writeread', v, s);
    assert.strictEqual(v.stdout, 'hello');
  });

  it('handler ctx.env reflects extension env on both backends', async () => {
    function envExt(): SandboxExtension {
      return {
        env: { A: '1', B: 'two' },
        commands: [
          {
            name: 'envcap',
            handler: async (_args, ctx) => ({
              stdout: `${ctx.env.A}:${ctx.env.B}\n`,
              stderr: '',
              exitCode: 0,
            }),
          },
        ],
      };
    }

    const virtualBackend = await createVirtualSandbox({ fs: new InMemoryFs() });
    const virtual = await createRoutingSandbox({
      backend: virtualBackend,
      hostExtensions: [envExt()],
    });
    const shallow = await createRoutingSandbox({
      backend: await createShallowBackend(),
      hostExtensions: [envExt()],
    });

    const v = await virtual.executeCommand('envcap');
    const s = await shallow.executeCommand('envcap');
    assertParity('envcap', v, s);
    assert.strictEqual(v.stdout, '1:two\n');
  });
});
