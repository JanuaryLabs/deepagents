import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  type AgentRuntimeOptions,
  defineAgent,
} from '@deepagents/experimental/zukhruf';

const model = {} as AgentModel;
const sandbox = async () => ({}) as AgentSandbox;

function declaration(name: string, subagents: AgentDeclaration[] = []) {
  return defineAgent({ name, model, sandbox, instructions: [], subagents });
}

test('AgentRuntime rejects duplicate names anywhere in the declaration graph', () => {
  const root = declaration('root', [
    declaration('worker'),
    declaration('branch', [declaration('worker')]),
  ]);

  assert.throws(
    () => new AgentRuntime(root, {} as AgentRuntimeOptions),
    /duplicate agent declaration name "worker"/,
  );
});

test('AgentRuntime rejects blank declaration names', () => {
  const root = declaration('root', [declaration('  ')]);

  assert.throws(
    () => new AgentRuntime(root, {} as AgentRuntimeOptions),
    /agent declaration name cannot be empty/,
  );
});

test('AgentRuntime rejects declaration names with surrounding whitespace', () => {
  const root = declaration('root', [declaration(' researcher ')]);

  assert.throws(
    () => new AgentRuntime(root, {} as AgentRuntimeOptions),
    /agent declaration name " researcher " must not contain surrounding whitespace/,
  );
});
