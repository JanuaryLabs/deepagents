import { Chat } from '@ai-sdk/react';
import {
  type ChatTransport,
  type UIMessage,
  createUIMessageStream,
  generateId,
  simulateReadableStream,
} from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  errorRecoveryGuardrail,
} from '@deepagents/context';
import {
  TEXT2SQL_INDEX_PROGRESS_CHUNK,
  Text2Sql,
  instructions,
} from '@deepagents/text2sql';
import {
  Sqlite,
  type SqliteAdapterOptions,
  columnStats,
  columnValues,
  constraints,
  indexes,
  rowCount,
  tables,
} from '@deepagents/text2sql/sqlite';

const sandbox = await createBashTool();

function createMockModel(text = 'SELECT COUNT(*) FROM users') {
  return new MockLanguageModelV3({
    doStream: async () =>
      ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: text },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: '' },
              usage: {
                inputTokens: { total: 10 },
                outputTokens: { total: 5 },
              },
            },
          ],
        }),
      }) as any,
  });
}

function createAdapter(
  grounding: SqliteAdapterOptions['grounding'] = [
    tables(),
    constraints(),
    indexes(),
    rowCount(),
    columnStats(),
    columnValues(),
  ],
) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      status TEXT CHECK (status IN ('active', 'paused')),
      age INTEGER
    );
    CREATE INDEX idx_users_status ON users(status);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      total REAL,
      state TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO users (id, status, age) VALUES
      (1, 'active', 30),
      (2, 'paused', 40);
    INSERT INTO orders (id, user_id, total, state) VALUES
      (1, 1, 10.5, 'paid'),
      (2, 2, 22.0, 'pending');
  `);

  const adapter = new Sqlite({
    execute: (sql: string) => db.prepare(sql).all(),
    grounding,
  });

  return { adapter, db };
}

describe('Text2Sql client message allocation', () => {
  it('produces exactly ONE assistant message when index progress streams before model output', async () => {
    const { adapter, db } = createAdapter();
    try {
      const store = new InMemoryContextStore();
      const engine = new ContextEngine({
        store,
        chatId: `allocation-chat-${generateId()}`,
        userId: 'test-user',
      });
      const model = createMockModel();
      const text2sql = new Text2Sql({
        version: `allocation-${generateId()}`,
        adapters: { main: adapter },
        model,
      });

      const transport: ChatTransport<UIMessage> = {
        sendMessages: async ({ messages }) => {
          const last = messages[messages.length - 1] as UIMessage;
          await engine.continue(last);
          return createUIMessageStream({
            execute: async ({ writer }) => {
              const head = await engine.headMessage();
              if (!head || head.name !== 'assistant') {
                throw new Error(
                  'expected head to be an assistant message — call engine.continue() before chat()',
                );
              }
              writer.write({ type: 'start', messageId: head.id });
              const fragments = await text2sql.index({
                onProgress: (event) =>
                  writer.write({
                    type: TEXT2SQL_INDEX_PROGRESS_CHUNK,
                    data: event,
                  }),
              });
              engine.set(...instructions(), ...fragments);
              const ai = agent({
                name: 'text2sql',
                sandbox,
                model,
                context: engine,
                guardrails: [errorRecoveryGuardrail],
                maxGuardrailRetries: 3,
              });
              writer.merge(
                await chat(ai, { transform: () => new TransformStream() }),
              );
            },
          });
        },
        reconnectToStream: async () => null,
      };

      let resolveFinished!: () => void;
      let rejectFinished!: (err: unknown) => void;
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
      });

      const chatClient = new Chat<UIMessage>({
        transport,
        onFinish: () => resolveFinished(),
        onError: (e) => rejectFinished(e),
      });

      await chatClient.sendMessage({ text: 'How many users?' });
      await finished;

      const assistants = chatClient.messages.filter(
        (m) => m.role === 'assistant',
      );
      assert.strictEqual(
        assistants.length,
        1,
        `expected exactly 1 assistant message, got ${assistants.length}. ` +
          `Bug: progress chunks land before the inner start chunk, causing the AI SDK ` +
          `client allocator to push the assistant twice.`,
      );

      const progressParts = assistants[0].parts.filter(
        (p) => p.type === TEXT2SQL_INDEX_PROGRESS_CHUNK,
      );
      assert.strictEqual(
        progressParts.length,
        29,
        `expected 29 index-progress parts on the single assistant (one per progress event ` +
          `emitted by the default 6-grounding SQLite adapter for a 2-table schema), got ` +
          `${progressParts.length}`,
      );

      assert.ok(
        assistants[0].parts.some((p) => p.type === 'text'),
        'single assistant must carry the model text output',
      );
    } finally {
      db.close();
    }
  });
});
