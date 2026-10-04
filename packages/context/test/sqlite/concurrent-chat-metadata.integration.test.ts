import type { LanguageModelUsage } from 'ai';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  SqliteContextStore,
  assistantText,
  user,
} from '@deepagents/context';
import { Sqlite } from '@deepagents/test';

const sqlite = new Sqlite();

function usage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
  };
}

test('concurrent trackUsage calls accumulate both usages without losing one', async () => {
  const store = new InMemoryContextStore();
  const engine = new ContextEngine({
    store,
    chatId: 'usage-race',
    userId: 'user-1',
  });
  engine.set(user('turn 1'), assistantText('reply'));
  await engine.save();

  await Promise.all([
    engine.trackUsage(usage(100, 10)),
    engine.trackUsage(usage(200, 20)),
  ]);

  const chat = await store.getChat('usage-race');
  const stored = chat?.metadata?.usage as LanguageModelUsage | undefined;
  assert.equal(
    stored?.totalTokens,
    330,
    'both concurrent trackUsage calls must survive',
  );
  assert.equal(stored?.inputTokens, 300);
  assert.equal(stored?.outputTokens, 30);
});

test('independent stores merging different metadata keys both survive', async () => {
  await using database = await sqlite.database();
  const first = new SqliteContextStore(database.connection);
  using secondConnection = new DatabaseSync(database.path);
  const second = new SqliteContextStore(secondConnection);
  await first.createChat({ id: 'meta-chat', userId: 'user-1' });
  await Promise.all([
    first.updateChat('meta-chat', (chat) => ({
      metadata: { ...chat.metadata, alpha: 'from-first' },
    })),
    second.updateChat('meta-chat', (chat) => ({
      metadata: { ...chat.metadata, beta: 'from-second' },
    })),
  ]);

  const chat = await first.getChat('meta-chat');
  assert.deepEqual(chat?.metadata, {
    alpha: 'from-first',
    beta: 'from-second',
  });
});

test('an updater returning undefined aborts without writing', async () => {
  await using database = await sqlite.database();
  const first = new SqliteContextStore(database.connection);
  await first.createChat({ id: 'meta-chat', userId: 'user-1' });
  await first.updateChat('meta-chat', (chat) => ({
    metadata: { ...chat.metadata, keep: 'me' },
  }));

  const untouched = await first.updateChat('meta-chat', () => undefined);

  assert.deepEqual(untouched.metadata, { keep: 'me' });
  assert.deepEqual((await first.getChat('meta-chat'))?.metadata, {
    keep: 'me',
  });
});

test('updating metadata of a missing chat throws', async () => {
  await using database = await sqlite.database();
  const first = new SqliteContextStore(database.connection);
  await first.createChat({ id: 'meta-chat', userId: 'user-1' });
  await assert.rejects(
    first.updateChat('no-such-chat', (chat) => ({
      metadata: chat.metadata,
    })),
    /chat "no-such-chat" not found/,
  );
});
