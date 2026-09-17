import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentModel, AgentSandbox } from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  type AgentStack,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

const model = {} as AgentModel;
const sandbox = async () => ({}) as AgentSandbox;

function declaration(name: string, subagents: AgentDeclaration[] = []) {
  return defineAgent({ name, model, sandbox, instructions: [], subagents });
}

test('AgentRuntime rejects duplicate names anywhere in the declaration graph', async () => {
  const root = declaration('root', [
    declaration('worker'),
    declaration('branch', [declaration('worker')]),
  ]);

  const duplicateNamesSetup = new AgentRuntime(root);
  const duplicateNamesStack = defineStack(
    async () => ({}) as Awaited<ReturnType<AgentStack>>,
  );
  await assert.rejects(
    duplicateNamesSetup.initialize(duplicateNamesStack),
    /duplicate agent declaration name "worker"/,
  );
});

test('AgentRuntime rejects blank declaration names', async () => {
  const root = declaration('root', [declaration('  ')]);

  const blankNameSetup = new AgentRuntime(root);
  const blankNameStack = defineStack(
    async () => ({}) as Awaited<ReturnType<AgentStack>>,
  );
  await assert.rejects(
    blankNameSetup.initialize(blankNameStack),
    /agent declaration name cannot be empty/,
  );
});

test('AgentRuntime rejects declaration names with surrounding whitespace', async () => {
  const root = declaration('root', [declaration(' researcher ')]);

  const paddedNameSetup = new AgentRuntime(root);
  const paddedNameStack = defineStack(
    async () => ({}) as Awaited<ReturnType<AgentStack>>,
  );
  await assert.rejects(
    paddedNameSetup.initialize(paddedNameStack),
    /agent declaration name " researcher " must not contain surrounding whitespace/,
  );
});
