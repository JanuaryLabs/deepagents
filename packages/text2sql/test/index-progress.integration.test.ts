import { type UIMessage, generateId, simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  createBashTool,
} from '@deepagents/context';
import {
  Adapter,
  type IntrospectionProgress,
  TEXT2SQL_INDEX_PROGRESS_CHUNK,
  Text2Sql,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';
import {
  AbstractGrounding,
  type GroundingContext,
  createGroundingContext,
} from '@deepagents/text2sql/grounding';
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

class TestAdapter extends Adapter {
  override grounding = [];
  override readonly formatterLanguage = 'sqlite' as const;
  override readonly defaultSchema = undefined;
  override readonly systemSchemas: string[] = [];

  readonly #introspect: (
    ctx: GroundingContext,
  ) => Promise<ContextFragment[]> | ContextFragment[];

  constructor(
    introspect: (
      ctx: GroundingContext,
    ) => Promise<ContextFragment[]> | ContextFragment[],
  ) {
    super();
    this.#introspect = introspect;
  }

  override introspect(
    ctx = createGroundingContext(),
  ): Promise<ContextFragment[]> {
    return Promise.resolve(this.#introspect(ctx));
  }

  executeImpl(): any[] {
    return [];
  }

  validateImpl(): void {}

  runQuery<Row>(): Row[] {
    return [];
  }

  quoteIdentifier(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
  }

  escape(value: string): string {
    return value.replaceAll("'", "''");
  }

  buildSampleRowsQuery(
    tableName: string,
    columns: string[] | undefined,
    limit: number,
  ): string {
    const selected = columns?.map((column) => this.quoteIdentifier(column)) ?? [
      '*',
    ];
    return `SELECT ${selected.join(', ')} FROM ${this.quoteIdentifier(tableName)} LIMIT ${limit}`;
  }
}

class FailingGrounding extends AbstractGrounding {
  constructor() {
    super('failing', 'tables');
  }

  async execute(): Promise<void> {
    throw new Error('grounding failed');
  }
}

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

function userMessage(text: string): UIMessage {
  return {
    id: generateId(),
    role: 'user',
    parts: [{ type: 'text', text }],
  };
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

function createText2Sql(adapter: Sqlite, version = `progress-${generateId()}`) {
  const store = new InMemoryContextStore();
  const engine = new ContextEngine({
    store,
    chatId: `progress-chat-${generateId()}`,
    userId: 'test-user',
  });

  const text2sql = new Text2Sql({
    version,
    sandbox,
    adapters: { main: adapter },
    model: createMockModel(),
    transform: () => new TransformStream(),
    context: engine,
  });

  return { text2sql, engine };
}

async function collect(stream: ReadableStream): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

async function collectUntilError(
  stream: ReadableStream,
): Promise<{ chunks: unknown[]; error?: unknown }> {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  while (true) {
    try {
      const { done, value } = await reader.read();
      if (done) return { chunks };
      chunks.push(value);
    } catch (error) {
      return { chunks, error };
    }
  }
}

function isProgressChunk(chunk: unknown): chunk is {
  type: typeof TEXT2SQL_INDEX_PROGRESS_CHUNK;
  data: Text2SqlIndexProgressEvent;
} {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    'type' in chunk &&
    (chunk as { type?: unknown }).type === TEXT2SQL_INDEX_PROGRESS_CHUNK
  );
}

function progressEvents(chunks: unknown[]): Text2SqlIndexProgressEvent[] {
  return chunks.filter(isProgressChunk).map((chunk) => chunk.data);
}

function assertTimestamped(
  events: Array<Text2SqlIndexProgressEvent | IntrospectionProgress>,
) {
  for (const event of events) {
    const timestampMs = event.timestampMs;
    assert.strictEqual(
      typeof timestampMs,
      'number',
      `${event.type} should include timestampMs`,
    );
    assert.ok(
      Number.isFinite(timestampMs),
      `${event.type} timestampMs should be finite`,
    );
    assert.ok(
      !('elapsedMs' in event),
      `${event.type} should not expose elapsedMs; clients can derive duration from timestampMs`,
    );
  }
}

describe('Text2Sql index progress events', () => {
  it('emits index progress chunks before assistant stream chunks', async () => {
    const { adapter, db } = createAdapter();
    try {
      const { text2sql, engine } = createText2Sql(adapter);

      await engine.continue(userMessage('How many users?'));
      const stream = await text2sql.chat();
      const chunks = await collect(stream);
      const events = progressEvents(chunks);

      assert.ok(events.length > 0, 'expected index progress events');
      assertTimestamped(events);

      const startChunkIndex = chunks.findIndex(
        (chunk) => (chunk as { type?: string })?.type === 'start',
      );
      const firstProgressChunk = chunks.findIndex(isProgressChunk);
      const firstAssistantChunk = chunks.findIndex(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          ['text-start', 'text-delta'].includes(
            String((chunk as { type?: unknown }).type),
          ),
      );
      const lastProgressChunk = chunks.findLastIndex(isProgressChunk);

      assert.strictEqual(
        startChunkIndex,
        0,
        'start chunk must be at wire position 0 (carries assistant id before any data)',
      );
      assert.ok(firstProgressChunk > 0, 'expected index progress events');
      assert.ok(firstAssistantChunk >= 0, 'expected assistant text chunks');
      assert.ok(
        startChunkIndex < firstProgressChunk,
        'start chunk must precede the first progress chunk',
      );
      assert.ok(
        lastProgressChunk < firstAssistantChunk,
        'all index progress should arrive before assistant text',
      );

      assert.ok(events.some((e) => e.type === 'index:start'));
      assert.ok(events.some((e) => e.type === 'adapter:start'));
      assert.ok(events.some((e) => e.type === 'adapter:cache-miss'));
      assert.ok(
        events.some((e) => e.type === 'phase:progress' && e.adapter === 'main'),
      );
      assert.ok(events.some((e) => e.type === 'adapter:end'));
      assert.ok(events.some((e) => e.type === 'index:end'));

      const indexStart = events.find((e) => e.type === 'index:start');
      const indexEnd = events.find((e) => e.type === 'index:end');
      assert.ok(indexStart);
      assert.ok(indexEnd);
      assert.ok(typeof indexStart.timestampMs === 'number');
      assert.ok(typeof indexEnd.timestampMs === 'number');
      assert.ok(
        indexEnd.timestampMs >= indexStart.timestampMs,
        'clients should be able to derive non-negative duration from event timestamps',
      );
    } finally {
      db.close();
    }
  });

  it('emits cache-hit events without re-introspecting cached adapters', async () => {
    const { adapter, db } = createAdapter([tables()]);
    try {
      let introspectCalls = 0;
      const originalIntrospect = adapter.introspect.bind(adapter);
      adapter.introspect = async (...args) => {
        introspectCalls++;
        return originalIntrospect(...args);
      };

      const { text2sql, engine } = createText2Sql(
        adapter,
        `cache-${generateId()}`,
      );
      await engine.continue(userMessage('First question'));
      const first = await collect(await text2sql.chat());
      await engine.continue(userMessage('Second question'));
      const second = await collect(await text2sql.chat());
      const firstEvents = progressEvents(first);
      const secondEvents = progressEvents(second);

      assertTimestamped(firstEvents);
      assertTimestamped(secondEvents);

      assert.ok(
        firstEvents.some((e) => e.type === 'adapter:cache-miss'),
        'first chat should miss the cache',
      );
      assert.ok(
        secondEvents.some((e) => e.type === 'adapter:cache-hit'),
        'second chat should hit the cache',
      );
      assert.strictEqual(
        introspectCalls,
        1,
        'cached adapter should not be re-introspected',
      );
    } finally {
      db.close();
    }
  });

  it('emits grounding progress for table-level SQLite introspection work', async () => {
    const { adapter, db } = createAdapter();
    try {
      const events: IntrospectionProgress[] = [];
      await adapter.introspect(
        createGroundingContext({
          onProgress: (event) => events.push(event),
        }),
      );
      assertTimestamped(events);

      assert.ok(
        events.some((e) => e.type === 'phase:start' && e.phase === 'tables'),
        'tables phase should start',
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === 'phase:progress' &&
            e.phase === 'tables' &&
            e.table === 'users',
        ),
        'tables phase should report individual tables',
      );
      for (const phase of [
        'constraints',
        'indexes',
        'row_counts',
        'column_stats',
        'column_values',
      ] as const) {
        assert.ok(
          events.some((e) => e.type === 'phase:progress' && e.phase === phase),
          `${phase} should report progress`,
        );
      }
    } finally {
      db.close();
    }
  });

  it('emits terminal index errors after in-flight adapter progress settles', async () => {
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const failing = new TestAdapter(async () => {
      await slowStarted;
      setTimeout(releaseSlow, 0);
      throw new Error('fast adapter failed');
    });
    const slow = new TestAdapter(async (ctx) => {
      ctx.onProgress({
        type: 'phase:progress',
        phase: 'tables',
        message: 'slow adapter started',
      });
      markSlowStarted();
      await slowReleased;
      ctx.onProgress({
        type: 'phase:progress',
        phase: 'tables',
        message: 'slow adapter finished',
      });
      return [];
    });
    const store = new InMemoryContextStore();
    const engine = new ContextEngine({
      store,
      chatId: 'progress-error-chat',
      userId: 'test-user',
    });
    const text2sql = new Text2Sql({
      version: `settled-error-${generateId()}`,
      sandbox,
      adapters: { failing, slow },
      model: createMockModel(),
      transform: () => new TransformStream(),
      context: engine,
    });

    await engine.continue(userMessage('This should fail'));
    const { chunks } = await collectUntilError(await text2sql.chat());
    const events = progressEvents(chunks);
    assertTimestamped(events);
    const slowFinishedIndex = events.findIndex(
      (event) => event.message === 'slow adapter finished',
    );
    const indexErrorIndex = events.findIndex(
      (event) => event.type === 'index:error',
    );

    assert.ok(
      slowFinishedIndex >= 0,
      'slow adapter should finish before the terminal index error',
    );
    assert.ok(indexErrorIndex >= 0, 'index:error should be emitted');
    assert.ok(
      slowFinishedIndex < indexErrorIndex,
      'index:error must be emitted after in-flight adapter progress settles',
    );
    assert.strictEqual(
      indexErrorIndex,
      events.length - 1,
      'no progress should be emitted after index:error',
    );
    assert.ok(
      !chunks.some(
        (chunk) =>
          typeof chunk === 'object' &&
          chunk !== null &&
          'type' in chunk &&
          ['text-start', 'text-delta'].includes(
            String((chunk as { type?: unknown }).type),
          ),
      ),
      'assistant stream should not start after indexing fails',
    );
  });

  it('closes the current introspection phase when a grounding throws', async () => {
    const adapter = new Sqlite({
      execute: () => [],
      grounding: [() => new FailingGrounding()],
    });
    const events: IntrospectionProgress[] = [];

    await assert.rejects(
      () =>
        adapter.introspect(
          createGroundingContext({
            onProgress: (event) => events.push(event),
          }),
        ),
      /grounding failed/,
    );

    assertTimestamped(events);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ['phase:start', 'phase:end'],
    );
  });
});
