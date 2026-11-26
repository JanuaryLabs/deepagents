import { test } from '@zukhruf/parameterized-test';
import assert from 'node:assert/strict';

import { AgentPath } from '@deepagents/experimental/zukhruf';

test('agent paths keep siblings absolute and resolve relative names as descendants', () => {
  assert.equal(AgentPath.parse('/root/reviewer').toString(), '/root/reviewer');
  assert.equal(
    AgentPath.parse('/root/coordinator').resolve('researcher').toString(),
    '/root/coordinator/researcher',
  );
  assert.equal(
    AgentPath.parse('/root/coordinator').resolve('/root/reviewer').toString(),
    '/root/reviewer',
  );
});

test('agent paths expose root and prefix membership semantics', () => {
  const root = AgentPath.root();
  const coordinator = root.resolve('coordinator');
  const researcher = coordinator.resolve('researcher');

  assert.equal(root.isRoot, true);
  assert.equal(coordinator.isRoot, false);
  assert.equal(root.contains(researcher), true);
  assert.equal(coordinator.contains(researcher), true);
  assert.equal(researcher.contains(coordinator), false);
});

void test.each(['/other/agent', '/root//agent', '/root/../agent'], (path) =>
  test(`agent paths reject the malformed or escaping path ${path}`, () => {
    assert.throws(() => AgentPath.parse(path), /agent path/);
  }),
);
