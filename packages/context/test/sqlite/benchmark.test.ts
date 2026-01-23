/**
 * SQLite Performance Benchmark
 *
 * Measures key operations before/after optimization.
 * Run with: node --test packages/context/test/sqlite/benchmark.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  SqliteContextStore,
  XmlRenderer,
  user,
} from '@deepagents/context';

const renderer = new XmlRenderer();

async function withTempDb<T>(
  fn: (store: SqliteContextStore) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx-bench-'));
  const dbPath = path.join(dir, 'bench.sqlite');
  const store = new SqliteContextStore(dbPath);
  try {
    return await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeUserMessage(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

describe('SQLite Performance Benchmark', () => {
  it(
    'benchmark: addMessage throughput (1000 messages)',
    { timeout: 60000 },
    async () => {
      await withTempDb(async (store) => {
        const chatId = 'bench-add';
        const engine = new ContextEngine({ store, chatId, userId: 'u1' });

        const count = 1000;
        const start = performance.now();

        for (let i = 0; i < count; i++) {
          engine.set(user(makeUserMessage(`msg-${i}`, `Message content ${i}`)));
          if ((i + 1) % 100 === 0) {
            await engine.save();
          }
        }
        await engine.save();

        const elapsed = performance.now() - start;
        const msgsPerSec = (count / elapsed) * 1000;

        console.log(
          `\n[BENCHMARK] addMessage: ${count} messages in ${elapsed.toFixed(0)}ms (${msgsPerSec.toFixed(0)} msg/s)`,
        );
      });
    },
  );

  it(
    'benchmark: getMessageChain (5000 messages)',
    { timeout: 120000 },
    async () => {
      await withTempDb(async (store) => {
        const chatId = 'bench-chain';
        const engine = new ContextEngine({ store, chatId, userId: 'u1' });

        // Build chain
        const count = 5000;
        for (let i = 0; i < count; i++) {
          engine.set(user(makeUserMessage(`msg-${i}`, `Message ${i}`)));
          if ((i + 1) % 500 === 0) {
            await engine.save();
          }
        }
        await engine.save();

        // Measure resolve (which calls getMessageChain internally)
        const start = performance.now();
        const result = await engine.resolve({ renderer });
        const elapsed = performance.now() - start;

        console.log(
          `\n[BENCHMARK] getMessageChain: ${result.messages.length} messages resolved in ${elapsed.toFixed(0)}ms`,
        );
      });
    },
  );

  it(
    'benchmark: listBranches with multiple branches',
    { timeout: 120000 },
    async () => {
      await withTempDb(async (store) => {
        const chatId = 'bench-branches';
        const engine = new ContextEngine({ store, chatId, userId: 'u1' });

        // Create base chain with 100 messages
        for (let i = 0; i < 100; i++) {
          engine.set(user(makeUserMessage(`msg-${i}`, `Message ${i}`)));
        }
        await engine.save();

        // Create 10 branches, each forking from message 50
        for (let b = 0; b < 10; b++) {
          await engine.rewind('msg-50');
          for (let i = 0; i < 20; i++) {
            engine.set(
              user(
                makeUserMessage(`branch-${b}-msg-${i}`, `Branch ${b} msg ${i}`),
              ),
            );
          }
          await engine.save();
        }

        // Measure listBranches
        const start = performance.now();
        const branches = await store.listBranches(chatId);
        const elapsed = performance.now() - start;

        console.log(
          `\n[BENCHMARK] listBranches: ${branches.length} branches in ${elapsed.toFixed(0)}ms`,
        );
        for (const b of branches) {
          console.log(`  - ${b.name}: ${b.messageCount} messages`);
        }
      });
    },
  );

  it(
    'benchmark: getActiveBranch (1000 calls)',
    { timeout: 30000 },
    async () => {
      await withTempDb(async (store) => {
        const chatId = 'bench-active';
        await store.upsertChat({ id: chatId, userId: 'u1' });

        const count = 1000;
        const start = performance.now();

        for (let i = 0; i < count; i++) {
          await store.getActiveBranch(chatId);
        }

        const elapsed = performance.now() - start;
        const callsPerSec = (count / elapsed) * 1000;

        console.log(
          `\n[BENCHMARK] getActiveBranch: ${count} calls in ${elapsed.toFixed(0)}ms (${callsPerSec.toFixed(0)} calls/s)`,
        );
      });
    },
  );

  it(
    'benchmark: listChats with userId filter (100 chats)',
    { timeout: 30000 },
    async () => {
      await withTempDb(async (store) => {
        // Create 100 chats for user-1 and 100 for user-2
        for (let i = 0; i < 100; i++) {
          await store.createChat({ id: `chat-u1-${i}`, userId: 'user-1' });
          await store.createChat({ id: `chat-u2-${i}`, userId: 'user-2' });
        }

        const count = 100;
        const start = performance.now();

        for (let i = 0; i < count; i++) {
          await store.listChats({ userId: 'user-1', limit: 20 });
        }

        const elapsed = performance.now() - start;
        const callsPerSec = (count / elapsed) * 1000;

        console.log(
          `\n[BENCHMARK] listChats(userId): ${count} calls in ${elapsed.toFixed(0)}ms (${callsPerSec.toFixed(0)} calls/s)`,
        );
      });
    },
  );
});
