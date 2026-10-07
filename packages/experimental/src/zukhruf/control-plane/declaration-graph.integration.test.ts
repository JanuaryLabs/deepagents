import { MockLanguageModelV4 } from 'ai/test';
import { InMemoryFs } from 'just-bash';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AgentSandbox,
  InMemoryContextStore,
  PollingChangeSource,
  SqliteStreamStore,
  StreamManager,
  createBashTool,
  createVirtualSandbox,
} from '@deepagents/context';
import {
  type AgentDeclaration,
  AgentRuntime,
  SqliteMailboxStore,
  type TurnActivity,
  TurnQueue,
  type TurnRef,
  defineAgent,
  defineStack,
} from '@deepagents/experimental/zukhruf';

/** Turns are never scheduled by runtimes that are only initialized. */
class UnusedTurnQueue extends TurnQueue {
  override async push(): Promise<void> {
    throw unusedQueue();
  }

  override async getTurnActivity(): Promise<TurnActivity> {
    throw unusedQueue();
  }

  override async getCurrentTurn(): Promise<TurnRef | undefined> {
    throw unusedQueue();
  }

  override async cancel(): Promise<void> {
    throw unusedQueue();
  }

  override async consume(): Promise<AsyncDisposable> {
    throw unusedQueue();
  }

  override async resumeParked(): Promise<void> {
    throw unusedQueue();
  }
}

function unusedQueue(): Error {
  return new Error('this test never schedules a turn');
}

/** In-memory adapters for runtimes that are initialized but never worked. */
function adapters(resources: AsyncDisposableStack) {
  const streamStore = new SqliteStreamStore(':memory:');
  resources.defer(() => streamStore.close());
  return {
    store: new InMemoryContextStore(),
    streams: new StreamManager({
      store: streamStore,
      changeSource: new PollingChangeSource({ reads: streamStore }),
    }),
    queue: new UnusedTurnQueue(),
    mailboxStore: resources.use(new SqliteMailboxStore(':memory:')),
  };
}

async function virtualSandbox(): Promise<AgentSandbox> {
  return createBashTool({
    sandbox: await createVirtualSandbox({ fs: new InMemoryFs() }),
  });
}

const model = new MockLanguageModelV4();
const sandbox = virtualSandbox;

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
