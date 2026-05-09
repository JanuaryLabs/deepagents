import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type SubcommandDefinition,
  createBashTool,
  createVirtualSandbox,
  defineSubcommandGroup,
  useBashMeta,
} from '@deepagents/context';

const markerSubcommands = {
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

function createMarkerSandbox() {
  return createVirtualSandbox({
    fs: new InMemoryFs(),
    customCommands: [defineSubcommandGroup('marker', markerSubcommands)],
  });
}

describe('bash-meta wiring through createBashTool', () => {
  it('toModelOutput strips meta but preserves reminder and stdout', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });

    const bash = tools.bash as unknown as {
      toModelOutput: (a: {
        toolCallId: string;
        input: { command: string; reasoning: string };
        output: unknown;
      }) => Promise<{ type: 'json'; value: Record<string, unknown> }>;
    };

    const modelOutput = await bash.toModelOutput({
      toolCallId: 't',
      input: { command: 'marker hide foo 1', reasoning: 'r' },
      output: {
        stdout: 'hi\n',
        stderr: '',
        exitCode: 0,
        reminder: 'visible',
        meta: { sql: 'SELECT 1' },
      },
    });

    assert.strictEqual(modelOutput.type, 'json');
    assert.strictEqual(modelOutput.value.meta, undefined);
    assert.strictEqual(modelOutput.value.reminder, 'visible');
    assert.strictEqual(modelOutput.value.stdout, 'hi\n');
  });

  it('plain commands attach no meta and no reminder', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });
    const execute = tools.bash.execute!;

    const result = (await execute(
      { command: 'echo hello', reasoning: 'r' },
      {} as never,
    )) as unknown as Record<string, unknown>;

    assert.strictEqual(result.meta, undefined);
    assert.strictEqual(result.reminder, undefined);
  });

  it('parallel tool calls each see their own meta frame', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });
    const execute = tools.bash.execute!;

    const [a, b, plain] = await Promise.all([
      execute({ command: 'marker hide alpha 1', reasoning: 'p1' }, {} as never),
      execute({ command: 'marker hide beta 2', reasoning: 'p2' }, {} as never),
      execute({ command: 'echo plain', reasoning: 'p3' }, {} as never),
    ]);

    assert.deepStrictEqual((a as unknown as Record<string, unknown>).meta, {
      alpha: '1',
    });
    assert.deepStrictEqual((b as unknown as Record<string, unknown>).meta, {
      beta: '2',
    });
    assert.strictEqual(
      (plain as unknown as Record<string, unknown>).meta,
      undefined,
    );
  });

  it('reminder set by one parallel call does not leak into another', async () => {
    const { tools } = await createBashTool({
      sandbox: await createMarkerSandbox(),
      destination: '/',
    });
    const execute = tools.bash.execute!;

    const [withReminder, without] = await Promise.all([
      execute(
        { command: 'marker remind stay-focused', reasoning: 'r1' },
        {} as never,
      ),
      execute({ command: 'echo other', reasoning: 'r2' }, {} as never),
    ]);

    assert.strictEqual(
      (withReminder as unknown as Record<string, unknown>).reminder,
      'stay-focused',
    );
    assert.strictEqual(
      (without as unknown as Record<string, unknown>).reminder,
      undefined,
    );
  });
});
