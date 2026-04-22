import { InMemoryFs } from 'just-bash';
import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  type SubcommandDefinition,
  buildSubcommandRepair,
  createRoutingSandbox,
  createVirtualSandbox,
  defineSubcommandGroup,
  repairQuotedArg,
  stripQuoteArtifacts,
} from '@deepagents/context';

function fooHandler() {
  return { stdout: 'foo-out\n', stderr: '', exitCode: 0 };
}

function barHandler(args: string[]) {
  return { stdout: `bar-${args.join(',')}\n`, stderr: '', exitCode: 0 };
}

const subcommands = {
  foo: {
    usage: 'foo',
    description: 'Run the foo subcommand',
    handler: fooHandler,
  },
  bar: {
    usage: 'bar <x> <y>',
    description: 'Run the bar subcommand with two args',
    handler: barHandler,
  },
} satisfies Record<string, SubcommandDefinition>;

async function exec(command: string) {
  const group = defineSubcommandGroup('tool', subcommands);
  const backend = await createVirtualSandbox({ fs: new InMemoryFs() });
  const sandbox = await createRoutingSandbox({
    backend,
    hostExtensions: [{ commands: [group] }],
  });
  return sandbox.executeCommand(command);
}

describe('defineSubcommandGroup: dispatch', () => {
  it('routes to the matching subcommand handler', async () => {
    const result = await exec('tool foo');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'foo-out\n');
  });

  it('forwards remaining args to the handler', async () => {
    const result = await exec('tool bar 1 2');
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.stdout, 'bar-1,2\n');
  });
});

describe('defineSubcommandGroup: error messages', () => {
  it('missing subcommand returns exitCode 1 with usage', async () => {
    const result = await exec('tool');
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /missing subcommand/);
    assert.match(result.stderr, /tool foo/);
    assert.match(result.stderr, /tool bar/);
  });

  it('unknown subcommand returns exitCode 1 naming the bad arg', async () => {
    const result = await exec('tool baz');
    assert.strictEqual(result.exitCode, 1);
    assert.match(result.stderr, /unknown subcommand 'baz'/);
    assert.match(result.stderr, /Usage:/);
  });
});

describe('buildSubcommandRepair: pass-through', () => {
  it('returns the raw command unchanged when it already parses', () => {
    const repair = buildSubcommandRepair('tool', subcommands);
    assert.strictEqual(repair('tool foo'), 'tool foo');
    assert.strictEqual(repair('tool bar "a" "b"'), 'tool bar "a" "b"');
  });

  it('returns the raw command unchanged when the pattern does not match', () => {
    const repair = buildSubcommandRepair('tool', subcommands);
    assert.strictEqual(repair('echo hello'), 'echo hello');
    assert.strictEqual(repair('tool'), 'tool');
  });
});

describe('buildSubcommandRepair: applies per-subcommand repair', () => {
  it('invokes the subcommand repair function when raw fails to parse', () => {
    const withRepair = {
      foo: {
        usage: 'foo',
        description: '',
        repair: (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return null;
          const escaped = trimmed.replace(/'/g, "'\\''");
          return `'${escaped}'`;
        },
        handler: fooHandler,
      },
    } satisfies Record<string, SubcommandDefinition>;

    const repair = buildSubcommandRepair('tool', withRepair);
    const repaired = repair(`tool foo don't worry`);
    assert.match(repaired, /tool foo '/);
    assert.match(repaired, /don/);
  });

  it('falls back to raw when the repaired output still fails to parse', () => {
    const withBadRepair = {
      foo: {
        usage: 'foo',
        description: '',
        repair: () => `'`,
        handler: fooHandler,
      },
    } satisfies Record<string, SubcommandDefinition>;

    const repair = buildSubcommandRepair('tool', withBadRepair);
    const raw = `tool foo don't worry`;
    assert.strictEqual(repair(raw), raw);
  });

  it('returns raw unchanged when the subcommand has no repair function', () => {
    const repair = buildSubcommandRepair('tool', subcommands);
    const malformed = `tool foo don't`;
    assert.strictEqual(repair(malformed), malformed);
  });
});

describe('stripQuoteArtifacts', () => {
  it('strips matching outer double quotes', () => {
    assert.strictEqual(stripQuoteArtifacts('"SELECT 1"'), 'SELECT 1');
  });

  it('strips matching outer single quotes', () => {
    assert.strictEqual(stripQuoteArtifacts("'SELECT 1'"), 'SELECT 1');
  });

  it('leaves unquoted strings alone (trimmed)', () => {
    assert.strictEqual(stripQuoteArtifacts('  SELECT 1  '), 'SELECT 1');
  });

  it('strips a leading quote even when the closer is missing', () => {
    assert.strictEqual(stripQuoteArtifacts('"unclosed'), 'unclosed');
    assert.strictEqual(stripQuoteArtifacts("'unclosed"), 'unclosed');
  });

  it('only strips one layer', () => {
    assert.strictEqual(stripQuoteArtifacts(`"'nested'"`), `'nested'`);
  });
});

describe('repairQuotedArg', () => {
  it('wraps a clean arg in single quotes', () => {
    assert.strictEqual(repairQuotedArg('SELECT 1'), `'SELECT 1'`);
  });

  it('strips existing outer quotes before re-wrapping', () => {
    assert.strictEqual(repairQuotedArg('"SELECT 1"'), `'SELECT 1'`);
    assert.strictEqual(repairQuotedArg("'SELECT 1'"), `'SELECT 1'`);
  });

  it('escapes inner single quotes using the POSIX idiom', () => {
    assert.strictEqual(repairQuotedArg(`don't`), `'don'\\''t'`);
  });

  it('returns null for empty or whitespace-only input', () => {
    assert.strictEqual(repairQuotedArg(''), null);
    assert.strictEqual(repairQuotedArg('   '), null);
    assert.strictEqual(repairQuotedArg('""'), null);
  });
});
