import assert from 'node:assert/strict';
import test from 'node:test';

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

test('agent paths reject malformed and escaping segments', () => {
  for (const path of ['/other/agent', '/root//agent', '/root/../agent']) {
    assert.throws(() => AgentPath.parse(path), /agent path/);
  }
});
