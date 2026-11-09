import { MockLanguageModelV4 } from 'ai/test';
import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryContextStore, SqliteStreamStore } from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  SqliteMailboxStore,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

import { buildSandbox } from '../../testing/build-sandbox.fixture.ts';
import { streamsFor } from '../../testing/streams-for.fixture.ts';
import { UnusedTurnQueue } from '../../testing/unused-turn-queue.fixture.ts';

/** In-memory adapters for runtimes that are initialized but never worked. */
function adapters(resources: AsyncDisposableStack) {
  const streamStore = new SqliteStreamStore(':memory:');
  resources.defer(() => streamStore.close());
  return {
    store: new InMemoryContextStore(),
    streams: streamsFor(streamStore),
    queue: new UnusedTurnQueue(),
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

const model = new MockLanguageModelV4();
const sandbox = buildSandbox;

function declaration(name: string, subagents: AgentDeclaration[] = []) {
  return defineAgent({ name, model, sandbox, instructions: [], subagents });
}

test('AgentRuntime rejects duplicate names anywhere in the declaration graph', async () => {
  const root = declaration('root', [
    declaration('worker'),
    declaration('branch', [declaration('worker')]),
  ]);

  const duplicateNamesSetup = new AgentRuntime(root);
  const duplicateNamesStack = defineStack(async (resources) =>
    adapters(resources),
  );
  await assert.rejects(
    duplicateNamesSetup.initialize(duplicateNamesStack),
    /duplicate agent declaration name "worker"/,
  );
});

test('AgentRuntime rejects blank declaration names', async () => {
  const root = declaration('root', [declaration('  ')]);

  const blankNameSetup = new AgentRuntime(root);
  const blankNameStack = defineStack(async (resources) => adapters(resources));
  await assert.rejects(
    blankNameSetup.initialize(blankNameStack),
    /agent declaration name cannot be empty/,
  );
});

test('AgentRuntime rejects declaration names with surrounding whitespace', async () => {
  const root = declaration('root', [declaration(' researcher ')]);

  const paddedNameSetup = new AgentRuntime(root);
  const paddedNameStack = defineStack(async (resources) => adapters(resources));
  await assert.rejects(
    paddedNameSetup.initialize(paddedNameStack),
    /agent declaration name " researcher " must not contain surrounding whitespace/,
  );
});
