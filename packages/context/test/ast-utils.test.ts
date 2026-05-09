import type { CommandNode, WordNode } from 'just-bash';
import { parse } from 'just-bash';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { asStaticWordText } from '@deepagents/context';

function firstArg(command: string): WordNode {
  const script = parse(command);
  const commandNode = script.statements[0].pipelines[0].commands[0] as Extract<
    CommandNode,
    { type: 'SimpleCommand' }
  >;
  const arg = commandNode.args[0];
  assert.ok(arg);
  return arg;
}

describe('asStaticWordText', () => {
  it('rejects legacy command substitutions by default because they execute shell', () => {
    assert.equal(asStaticWordText(firstArg('echo `date`')), null);
  });

  it('can preserve legacy backticks as text for callers that own the nested language', () => {
    assert.equal(
      asStaticWordText(firstArg('echo "SELECT `first_name` FROM users"'), {
        preserveLegacyBackticks: true,
      }),
      'SELECT `first_name` FROM users',
    );
  });
});
