import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type SubcommandDefinition,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  defineSubcommandGroup,
  useBashMeta,
} from '@deepagents/context';

/**
 * Builds a sandbox with a `marker` subcommand group whose handlers write
 * to the generic meta channel. Used to exercise bash-meta behavior without
 * pulling in any SQL-specific setup.
 */
async function createMarkerSandbox() {
  const subcommands = {
    hide: {
      usage: 'hide <key> <value>',
      description: 'Write key/value to hidden meta',
      handler: (args) => {
        useBashMeta()?.setHidden({ [args[0]]: args[1] });
        return { stdout: `hidden:${args[0]}\n`, stderr: '', exitCode: 0 };
      },
    },
    remind: {
      usage: 'remind <text>',
      description: 'Set a model-visible reminder',
      handler: (args) => {
        useBashMeta()?.setReminder(args.join(' '));
        return { stdout: 'reminded\n', stderr: '', exitCode: 0 };
      },
    },
  } satisfies Record<string, SubcommandDefinition>;

  const group = defineSubcommandGroup('marker', subcommands);
  const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
  return createRoutingSandbox({
    backend,
    hostExtensions: [{ commands: [group] }],
  });
}

describe('bash-meta: toModelOutput strips meta', () => {
  it('removes `meta` while preserving other fields', async () => {
    const { tools } = await createBashTool({});

    const bash = tools.bash as unknown as {
      toModelOutput: (args: {
        toolCallId: string;
        input: { command: string; reasoning: string };
        output: unknown;
      }) => Promise<{ type: 'json'; value: Record<string, unknown> }>;
    };
    assert.ok(bash.toModelOutput, 'bash tool should have toModelOutput');

    const mockOutput = {
      stdout: 'marker output\n',
      stderr: '',
      exitCode: 0,
      reminder: 'visible hint',
      meta: { formattedSql: 'SELECT 1' },
    };

    const modelOutput = await bash.toModelOutput({
      toolCallId: 'test',
      input: { command: 'marker hide foo 1', reasoning: 'test' },
      output: mockOutput,
    });

    assert.strictEqual(modelOutput.type, 'json');
    assert.strictEqual(modelOutput.value.meta, undefined);
    assert.strictEqual(modelOutput.value.stdout, mockOutput.stdout);
    assert.strictEqual(modelOutput.value.reminder, 'visible hint');
  });
});

describe('bash-meta: no meta attached when handler does not write', () => {
  it('plain commands have no meta field', async () => {
    const { tools } = await createBashTool({});
    const execute = tools.bash.execute!;

    const result = (await execute(
      { command: 'echo hello', reasoning: 'no-meta test' },
      {} as never,
    )) as unknown as Record<string, unknown>;

    assert.strictEqual(
      result.meta,
      undefined,
      'commands without setHidden should not attach meta',
    );
    assert.strictEqual(
      result.reminder,
      undefined,
      'commands without setReminder should not attach reminder',
    );
  });
});

describe('bash-meta: parallel calls get isolated state via AsyncLocalStorage', () => {
  it('three parallel tool calls each see their own meta frame', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });
    const execute = tools.bash.execute!;

    const [first, second, third] = await Promise.all([
      execute(
        { command: 'marker hide alpha 1', reasoning: 'parallel 1' },
        {} as never,
      ),
      execute(
        { command: 'marker hide beta 2', reasoning: 'parallel 2' },
        {} as never,
      ),
      execute({ command: 'echo plain', reasoning: 'parallel 3' }, {} as never),
    ]);

    const firstResult = first as unknown as Record<string, unknown>;
    const secondResult = second as unknown as Record<string, unknown>;
    const thirdResult = third as unknown as Record<string, unknown>;

    assert.deepStrictEqual(firstResult.meta, { alpha: '1' });
    assert.deepStrictEqual(secondResult.meta, { beta: '2' });
    assert.strictEqual(thirdResult.meta, undefined);
  });

  it('reminder set by one parallel call does not leak into another', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });
    const execute = tools.bash.execute!;

    const [withReminder, withoutReminder] = await Promise.all([
      execute(
        { command: 'marker remind stay-focused', reasoning: 'r1' },
        {} as never,
      ),
      execute({ command: 'echo other', reasoning: 'r2' }, {} as never),
    ]);

    const r1 = withReminder as unknown as Record<string, unknown>;
    const r2 = withoutReminder as unknown as Record<string, unknown>;

    assert.strictEqual(r1.reminder, 'stay-focused');
    assert.strictEqual(r2.reminder, undefined);
  });
});
