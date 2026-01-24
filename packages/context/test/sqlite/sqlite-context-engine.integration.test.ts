import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  ContextEngine,
  SqliteContextStore,
  XmlRenderer,
  assistantText,
  lastAssistantMessage,
  user,
} from '@deepagents/context';

const renderer = new XmlRenderer();

function sanitizeLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function withTempDb<T>(
  label: string,
  fn: (dbPath: string) => Promise<T>,
) {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `context-${sanitizeLabel(label)}-`),
  );
  const dbPath = path.join(dir, 'context.sqlite');
  try {
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withDiskImage<T>(
  label: string,
  sizeMegabytes: number,
  fn: (mountPath: string) => Promise<T>,
) {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), `context-${sanitizeLabel(label)}-`),
  );
  const imagePath = path.join(dir, 'disk.img');
  const mountPath = path.join(dir, 'mnt');
  try {
    await execFileAsync('hdiutil', [
      'create',
      '-size',
      `${sizeMegabytes}m`,
      '-fs',
      'APFS',
      '-volname',
      'ContextTest',
      '-ov',
      imagePath,
    ]);
    await mkdir(mountPath, { recursive: true });
    await execFileAsync('hdiutil', [
      'attach',
      `${imagePath}.dmg`,
      '-mountpoint',
      mountPath,
      '-nobrowse',
    ]);
    return await fn(mountPath);
  } finally {
    try {
      await execFileAsync('hdiutil', ['detach', mountPath]);
    } catch {
      // best effort cleanup
    }
    try {
      await execFileAsync('hdiutil', ['detach', mountPath, '-force']);
    } catch {
      // best effort cleanup
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTimeout<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
) {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const elapsed = Date.now() - start;
      reject(new Error(`[timeout] ${label} after ${elapsed}ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const execFileAsync = promisify(execFile);

function makeUserMessage(id: string, text: string) {
  return {
    id,
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }],
  };
}

function makeToolClarificationMessage(id: string) {
  return {
    id,
    role: 'assistant' as const,
    parts: [
      { type: 'step-start' as const },
      {
        type: 'reasoning' as const,
        text: 'User says: "let\'s create comprehensive report". Need to ask clarification.',
      },
      {
        type: 'tool-render_ask_user_question' as const,
        toolCallId: 'fc_b4063702-6bc7-420d-8a07-4153d9f3bffb',
        state: 'output-available' as const,
        input: {
          questions: [
            {
              options: [
                {
                  label: 'Performance (pixel rate, bandwidth)',
                  value: 'performance',
                },
                { label: 'Power & TDP', value: 'power' },
                { label: 'Memory specs', value: 'memory' },
                { label: 'Overall comparison of top GPUs', value: 'overall' },
                { label: 'Other (please specify)', value: 'other' },
              ],
              question:
                'Which specific areas would you like covered in the comprehensive report? For example, performance comparison, power usage, memory characteristics, or a mix of several metrics?',
              type: 'multiple_choice' as const,
            },
          ],
        },
        output: {
          answers: [
            {
              type: 'multiple_choice' as const,
              question:
                'Which specific areas would you like covered in the comprehensive report? For example, performance comparison, power usage, memory characteristics, or a mix of several metrics?',
              choices: [{ label: 'Memory specs', value: 'memory' }],
            },
          ],
        },
      },
    ],
  };
}

function getPragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  const direct = row?.[name];
  if (typeof direct === 'number') {
    return direct;
  }
  const fallback = Object.values(row ?? {})[0];
  if (typeof fallback === 'number') {
    return fallback;
  }
  throw new Error(`Unable to read PRAGMA ${name}`);
}

describe('Sqlite ContextEngine Integration', () => {
  it('resolves an empty chat without hanging', async () => {
    await withTempDb('empty-chat', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-empty',
        userId: 'user-1',
      });

      const result = await withTimeout('resolve empty chat', 10000, () =>
        engine.resolve({ renderer }),
      );
      assert.strictEqual(result.messages.length, 0);

      await withTimeout('save empty chat', 10000, () => engine.save());
    });
  });

  it('resolves when an empty sqlite file already exists', async () => {
    await withTempDb('empty-file', async (dbPath) => {
      await writeFile(dbPath, '');

      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-empty-file',
        userId: 'user-1',
      });

      const result = await withTimeout('resolve empty sqlite file', 10000, () =>
        engine.resolve({ renderer }),
      );
      assert.strictEqual(result.messages.length, 0);
    });
  });

  it('does not hang with a dangling parent chain', async () => {
    await withTempDb('dangling-parent', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-dangling',
        userId: 'user-1',
      });

      engine.set(user(makeUserMessage('msg-1', 'Root')));
      engine.set(assistantText('Middle', { id: 'msg-2' }));
      engine.set(user(makeUserMessage('msg-3', 'Leaf')));
      await withTimeout('save dangling chain setup', 10000, () =>
        engine.save(),
      );

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('DELETE FROM messages WHERE id = ?').run('msg-2');
      db.prepare('DELETE FROM messages_fts WHERE messageId = ?').run('msg-2');
      db.close();

      const result = await withTimeout(
        'resolve dangling parent',
        10000,
        async () => {
          try {
            return await engine.resolve({ renderer });
          } catch (error) {
            return { error } as { error: unknown };
          }
        },
      );

      if ('messages' in result) {
        assert.ok(result.messages.length >= 1);
      }
    });
  });

  it('does not hang when the active branch row is missing', async () => {
    await withTempDb('missing-branch', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-branch-missing',
        userId: 'user-1',
      });

      engine.set(user(makeUserMessage('msg-1', 'Hello')));
      await withTimeout('save branch setup', 10000, () => engine.save());

      const db = new DatabaseSync(dbPath);
      db.prepare('DELETE FROM branches WHERE chatId = ?').run(
        'chat-branch-missing',
      );
      db.close();

      const nextEngine = new ContextEngine({
        store,
        chatId: 'chat-branch-missing',
        userId: 'user-1',
      });

      await withTimeout('resolve missing branch', 10000, async () => {
        try {
          await nextEngine.resolve({ renderer });
        } catch {
          // No hang is the requirement for this edge case.
        }
      });
    });
  });

  it('does not hang when branch head points to a missing message', async () => {
    await withTempDb('missing-head', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-missing-head',
        userId: 'user-1',
      });

      engine.set(user(makeUserMessage('msg-1', 'Hello')));
      await withTimeout('save head setup', 10000, () => engine.save());

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('UPDATE branches SET headMessageId = ? WHERE chatId = ?').run(
        'missing-message',
        'chat-missing-head',
      );
      db.close();

      const nextEngine = new ContextEngine({
        store,
        chatId: 'chat-missing-head',
        userId: 'user-1',
      });

      const result = await withTimeout('resolve missing head', 10000, () =>
        nextEngine.resolve({ renderer }),
      );
      assert.strictEqual(result.messages.length, 0);
    });
  });

  it('rejects self-referential messages (circular reference protection)', async () => {
    await withTempDb('tool-cycle', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-tool-cycle',
        userId: 'user-1',
      });

      engine.set(
        user(makeUserMessage('msg-1', "let's create comprehensive report")),
      );
      await withTimeout('save tool user message', 10000, () => engine.save());

      const toolMessage = makeToolClarificationMessage('msg-2');

      // Attempting to add a message where parentId === id should be rejected
      await assert.rejects(async () => {
        await store.addMessage({
          id: toolMessage.id,
          chatId: 'chat-tool-cycle',
          parentId: toolMessage.id, // Self-referential - should be rejected
          name: 'user',
          type: 'message',
          data: toolMessage,
          createdAt: Date.now(),
        });
      }, /cannot be its own parent/);

      // The original message should still be accessible
      const result = await withTimeout('resolve after rejection', 10000, () =>
        engine.resolve({ renderer }),
      );
      assert.strictEqual(result.messages.length, 1);
    });
  });

  it('surfaces corruption errors without hanging', async () => {
    await withTempDb('corrupt-db', async (dbPath) => {
      await writeFile(dbPath, Buffer.from('not-a-database'));

      await withTimeout('corrupt db open', 10000, async () => {
        await assert.rejects(async () => {
          const store = new SqliteContextStore(dbPath);
          const engine = new ContextEngine({
            store,
            chatId: 'chat-corrupt',
            userId: 'user-1',
          });
          await engine.resolve({ renderer });
        }, /database|file/i);
      });
    });
  });

  it(
    'throws ERR_SQLITE_ERROR when disk image fills up',
    { timeout: 180000 },
    async () => {
      await withDiskImage('disk-image', 16, async (mountPath) => {
        const dbPath = path.join(mountPath, 'context.sqlite');
        const store = new SqliteContextStore(dbPath);
        const engine = new ContextEngine({
          store,
          chatId: 'chat-disk-image',
          userId: 'user-1',
        });

        await engine.resolve({ renderer });

        let failure: unknown;

        for (let index = 0; index < 5000; index += 1) {
          const payload = 'x'.repeat(1024 * 1024);
          engine.set(assistantText(payload, { id: `img-msg-${index}` }));
          try {
            await engine.save();
          } catch (error) {
            failure = error;
            break;
          }
        }

        if (!failure) {
          throw new Error('Expected SQLITE_FULL, but no error occurred');
        }

        const err = failure as {
          code?: string;
          errcode?: number;
          errstr?: string;
        };
        assert.strictEqual(err.code, 'ERR_SQLITE_ERROR');
        assert.strictEqual(err.errcode, 13);
        assert.match(err.errstr ?? '', /database or disk is full/i);
      });
    },
  );

  it(
    'resolves a large chain without hanging',
    { timeout: 180000 },
    async () => {
      await withTempDb('large-chain', async (dbPath) => {
        const store = new SqliteContextStore(dbPath);
        const engine = new ContextEngine({
          store,
          chatId: 'chat-large',
          userId: 'user-1',
        });

        const totalMessages = 25000;
        const batchSize = 500;

        for (let index = 0; index < totalMessages; index += 1) {
          engine.set(user(`message-${index}`));
          if ((index + 1) % batchSize === 0) {
            await withTimeout(
              `save batch ${(index + 1) / batchSize}`,
              60000,
              () => engine.save(),
            );
          }
        }

        if (totalMessages % batchSize !== 0) {
          await withTimeout('save final batch', 60000, () => engine.save());
        }

        const result = await withTimeout('resolve large chain', 120000, () =>
          engine.resolve({ renderer }),
        );
        assert.strictEqual(result.messages.length, totalMessages);
      });
    },
  );

  it('handles lastAssistantMessage in save() without encode error', async () => {
    await withTempDb('last-assistant-message', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-last-assistant',
        userId: 'user-1',
      });

      // First, add a user message and save
      engine.set(user(makeUserMessage('msg-1', 'Hello')));
      await withTimeout('save user message', 10000, () => engine.save());

      // Now simulate guardrail retry: set lastAssistantMessage and save
      // This should NOT throw "Cannot read properties of undefined (reading 'encode')"
      engine.set(
        lastAssistantMessage(
          'I tried something but it failed. Let me try again.',
        ),
      );
      await withTimeout('save lastAssistantMessage', 10000, () =>
        engine.save(),
      );

      // Verify the message was saved
      const result = await engine.resolve({ renderer });
      assert.strictEqual(result.messages.length, 2);
    });
  });

  it('handles lastAssistantMessage with existing pending user message', async () => {
    await withTempDb('last-assistant-with-pending', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-pending-mix',
        userId: 'user-1',
      });

      // Simulate the real guardrail flow:
      // 1. User message is set but NOT saved yet
      // 2. LLM tries to respond, guardrail catches error
      // 3. lastAssistantMessage is set for self-correction
      // 4. save() is called with BOTH messages pending

      engine.set(user(makeUserMessage('msg-1', 'Hello')));
      // Note: NOT saving here - user message is still pending

      // Now add lastAssistantMessage (simulating guardrail retry)
      engine.set(
        lastAssistantMessage(
          'I tried to call read_file but it does not exist. Let me try again.',
        ),
      );

      // This save should handle BOTH: user message (has codec) and lazy fragment
      await withTimeout('save mixed pending', 10000, () => engine.save());

      const result = await engine.resolve({ renderer });
      assert.strictEqual(result.messages.length, 2);
    });
  });

  it('resolve() handles pending lastAssistantMessage without encode error', async () => {
    await withTempDb('resolve-with-lazy', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-resolve-lazy',
        userId: 'user-1',
      });

      // Add user message and save first
      engine.set(user(makeUserMessage('msg-1', 'Hello')));
      await withTimeout('save user', 10000, () => engine.save());

      // Set lastAssistantMessage but DON'T save yet
      engine.set(
        lastAssistantMessage(
          'I tried to call read_file but it does not exist. Let me try again.',
        ),
      );

      // Now call resolve() with pending lazy fragment
      // This simulates what happens during retry when createRawStream calls resolve()
      // BEFORE save() has been called
      const result = await withTimeout('resolve with pending lazy', 10000, () =>
        engine.resolve({ renderer }),
      );

      // Should include both the saved user message and pending assistant message
      assert.strictEqual(result.messages.length, 2);
    });
  });

  it('creates new branch when saving message with existing ID (tool result scenario)', async () => {
    await withTempDb('tool-result-branch', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-tool-result',
        userId: 'user-1',
      });

      // 1. User message → save
      engine.set(user(makeUserMessage('user-msg-1', 'What is the weather?')));
      await engine.save();

      // 2. Assistant message with pending tool → save (head = assistant-pending)
      const pendingToolMessage = {
        id: 'assistant-pending',
        role: 'assistant' as const,
        parts: [
          { type: 'step-start' as const },
          {
            type: 'tool-render_ask_user_question' as const,
            toolCallId: 'fc_123',
            state: 'pending' as const,
            input: { questions: [{ question: 'Which city?', type: 'text' }] },
          },
        ],
      };
      engine.set(
        assistantText(JSON.stringify(pendingToolMessage), {
          id: 'assistant-pending',
        }),
      );
      await engine.save();

      // Verify we're on main branch with 2 messages
      assert.strictEqual(engine.branch, 'main');
      const beforeBranches = await store.listBranches('chat-tool-result');
      assert.strictEqual(beforeBranches.length, 1);

      // 3. Tool result comes back - set fragment with SAME ID (answered version)
      const answeredToolMessage = {
        id: 'assistant-pending',
        role: 'assistant' as const,
        parts: [
          { type: 'step-start' as const },
          {
            type: 'tool-render_ask_user_question' as const,
            toolCallId: 'fc_123',
            state: 'output-available' as const,
            input: { questions: [{ question: 'Which city?', type: 'text' }] },
            output: { answers: [{ type: 'text', answer: 'New York' }] },
          },
        ],
      };
      engine.set(
        assistantText(JSON.stringify(answeredToolMessage), {
          id: 'assistant-pending',
        }),
      );
      await engine.save();

      // 4. Verify new branch was created
      const afterBranches = await store.listBranches('chat-tool-result');
      assert.strictEqual(afterBranches.length, 2, 'Should have 2 branches now');
      assert.strictEqual(engine.branch, 'main-v2', 'Should be on new branch');

      // 5. Verify main-v2 chain: user → new_assistant (2 messages)
      const result = await engine.resolve({ renderer });
      assert.strictEqual(result.messages.length, 2);

      // 6. Verify main branch is preserved with original assistant message
      await engine.switchBranch('main');
      const mainResult = await engine.resolve({ renderer });
      assert.strictEqual(mainResult.messages.length, 2);
      const mainAssistant = mainResult.messages[1] as { id?: string };
      assert.strictEqual(mainAssistant.id, 'assistant-pending');
    });
  });

  it('creates new branch when lastAssistantMessage resolves to head (guardrail retry scenario)', async () => {
    await withTempDb('lazy-resolve-branch', async (dbPath) => {
      const store = new SqliteContextStore(dbPath);
      const engine = new ContextEngine({
        store,
        chatId: 'chat-lazy-resolve',
        userId: 'user-1',
      });

      // 1. User message → save
      engine.set(user(makeUserMessage('user-msg-1', 'Help me with code')));
      await engine.save();

      // 2. Assistant message → save (head = assistant message)
      engine.set(
        assistantText('Let me try to read the file...', {
          id: 'assistant-msg-1',
        }),
      );
      await engine.save();

      // Verify we're on main branch with 2 messages
      assert.strictEqual(engine.branch, 'main');
      const beforeBranches = await store.listBranches('chat-lazy-resolve');
      assert.strictEqual(beforeBranches.length, 1);

      // 3. lastAssistantMessage (simulating guardrail retry)
      //    This resolves to assistant-msg-1 which IS the current head
      engine.set(
        lastAssistantMessage(
          'Oops, read_file failed. Let me try again with the correct path.',
        ),
      );
      await engine.save();

      // 4. Verify new branch was created
      const afterBranches = await store.listBranches('chat-lazy-resolve');
      assert.strictEqual(afterBranches.length, 2, 'Should have 2 branches now');
      assert.strictEqual(engine.branch, 'main-v2', 'Should be on new branch');

      // 5. Verify main-v2 chain: user → new_assistant (2 messages)
      const result = await engine.resolve({ renderer });
      assert.strictEqual(result.messages.length, 2);
      const newAssistant = result.messages[1] as {
        parts?: Array<{ type: string; text?: string }>;
      };
      assert.ok(
        newAssistant.parts?.[0]?.text?.includes('try again'),
        'Should have corrected message',
      );

      // 6. Verify main branch is preserved with original assistant message
      await engine.switchBranch('main');
      const mainResult = await engine.resolve({ renderer });
      assert.strictEqual(mainResult.messages.length, 2);
      const mainAssistant = mainResult.messages[1] as {
        parts?: Array<{ type: string; text?: string }>;
      };
      assert.ok(
        mainAssistant.parts?.[0]?.text?.includes('try to read'),
        'Should have original message',
      );
    });
  });
});
