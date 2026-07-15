import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import * as zukhruf from '@deepagents/experimental/zukhruf';

const { defineAgent } = zukhruf;

const model = {} as AgentModel;
const sandbox = async () => ({}) as AgentSandbox;

test('defineAgent declares the subagents an agent may spawn', () => {
  const researcher = defineAgent({
    name: 'researcher',
    model,
    sandbox,
    instructions: [],
  });
  const root = defineAgent({
    name: 'root',
    model,
    sandbox,
    instructions: [],
    subagents: [researcher],
  });

  assert.deepEqual(root.subagents, [researcher]);
  assert.deepEqual(researcher.subagents, []);
});

test('defineAgent leaves collaboration-tool injection to turn execution', () => {
  const declaration = defineAgent({
    name: 'root',
    model,
    sandbox,
    instructions: [],
  });

  assert.deepEqual(declaration.tools, {});
});

test('the customer barrel hides runtime wiring and injected tool implementations', () => {
  for (const internal of [
    'AgentControlPlane',
    'AgentDeclarationRegistry',
    'AgentDirectory',
    'AgentStatusProjector',
    'AgentTurnExecutor',
    'ApprovalController',
    'MailboxCoordinator',
    'spawnAgentTool',
    'sendMessageTool',
    'followupTaskTool',
    'listAgentsTool',
    'waitAgentTool',
    'interruptAgentTool',
  ]) {
    assert.equal(internal in zukhruf, false, `${internal} is internal wiring`);
  }
});
