import type { TransformPlugin } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  DuplicateCommandError,
  type ExtensionCommand,
  chainHooks,
  mergeExtensions,
} from '@deepagents/context';

const noopCommand = (name: string): ExtensionCommand => ({
  name,
  handler: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
});

class TestPlugin {
  public readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

describe('mergeExtensions', () => {
  it('returns empty defaults when given no extensions', () => {
    const merged = mergeExtensions();
    assert.deepStrictEqual(merged.commands, []);
    assert.deepStrictEqual(merged.plugins, []);
    assert.deepStrictEqual(merged.env, {});
    assert.strictEqual(merged.onBeforeBashCall, undefined);
  });

  it('concatenates commands and plugins in order', () => {
    const a = noopCommand('a');
    const b = noopCommand('b');
    const p1 = new TestPlugin('p1') as unknown as TransformPlugin;
    const p2 = new TestPlugin('p2') as unknown as TransformPlugin;

    const merged = mergeExtensions(
      { commands: [a], plugins: [p1] },
      { commands: [b], plugins: [p2] },
    );

    assert.deepStrictEqual(
      merged.commands.map((c) => c.name),
      ['a', 'b'],
    );
    assert.deepStrictEqual(
      (merged.plugins as unknown as TestPlugin[]).map((p) => p.id),
      ['p1', 'p2'],
    );
  });

  it('throws DuplicateCommandError when two extensions share a command name', () => {
    const first = noopCommand('duplicated-name');
    const second = noopCommand('duplicated-name');
    assert.throws(
      () => mergeExtensions({ commands: [first] }, { commands: [second] }),
      (err: Error) => {
        assert.ok(err instanceof DuplicateCommandError);
        assert.strictEqual(err.name, 'DuplicateCommandError');
        assert.strictEqual(
          (err as DuplicateCommandError).commandName,
          'duplicated-name',
        );
        return true;
      },
    );
  });

  it('merges env with last-wins semantics', () => {
    const merged = mergeExtensions(
      { env: { A: '1', B: '2' } },
      { env: { B: 'overridden', C: '3' } },
    );

    assert.deepStrictEqual(merged.env, { A: '1', B: 'overridden', C: '3' });
  });

  it('chains onBeforeBashCall hooks so each sees the prior output', async () => {
    const merged = mergeExtensions(
      { onBeforeBashCall: ({ command }) => ({ command: command + ' + one' }) },
      {
        onBeforeBashCall: async ({ command }) => ({
          command: command + ' + two',
        }),
      },
      {
        onBeforeBashCall: ({ command }) => ({ command: command + ' + three' }),
      },
    );

    assert.ok(merged.onBeforeBashCall);
    const result = await merged.onBeforeBashCall!({ command: 'start' });
    assert.strictEqual(result.command, 'start + one + two + three');
  });

  it('omits onBeforeBashCall when no extension provides one', () => {
    const merged = mergeExtensions({ commands: [noopCommand('x')] });
    assert.strictEqual(merged.onBeforeBashCall, undefined);
  });

  it('skips missing fields without throwing', () => {
    const merged = mergeExtensions({}, {});
    assert.deepStrictEqual(merged.commands, []);
    assert.deepStrictEqual(merged.plugins, []);
    assert.deepStrictEqual(merged.env, {});
    assert.strictEqual(merged.onBeforeBashCall, undefined);
  });
});

describe('chainHooks', () => {
  it('applies hooks sequentially, passing each output forward', async () => {
    const chained = chainHooks<number>(
      (n) => n + 1,
      async (n) => n * 10,
      (n) => n - 3,
    );
    const result = await chained(5);
    assert.strictEqual(result, 57);
  });

  it('returns input unchanged when no hooks are provided', async () => {
    const chained = chainHooks<string>();
    assert.strictEqual(await chained('unchanged'), 'unchanged');
  });
});
