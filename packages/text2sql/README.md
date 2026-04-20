# @deepagents/text2sql

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

## Features

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, SQL Server, MySQL/MariaDB, and BigQuery adapters
- **Schema-Aware** - Automatic introspection of tables, relationships, indexes, and constraints
- **Domain Knowledge** - Inject business terms, guardrails, and query patterns via fragments
- **Conversational** - Multi-turn conversations with context persistence
- **Safe by Default** - Read-only queries, validation, and configurable guardrails

## Installation

```bash
npm install @deepagents/text2sql
```

Requires Node.js LTS (20+).

## Quick Start

```typescript
import { groq } from '@ai-sdk/groq';
import { InMemoryFs } from 'just-bash';
import pg from 'pg';

import { ContextEngine, InMemoryContextStore } from '@deepagents/context';
import { Text2Sql } from '@deepagents/text2sql';
import {
  Postgres,
  columnValues,
  constraints,
  indexes,
  info,
  rowCount,
  tables,
  views,
} from '@deepagents/text2sql/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const store = new InMemoryContextStore();
const adapter = new Postgres({
  execute: async (sql) => {
    const result = await pool.query(sql);
    return result.rows;
  },
  grounding: [
    tables(),
    views(),
    info(),
    indexes(),
    constraints(),
    rowCount(),
    columnValues(),
  ],
});

const text2sql = new Text2Sql({
  version: 'v1',
  model: groq('openai/gpt-oss-20b'),
  filesystem: new InMemoryFs(),
  adapter,
  context: (...fragments) => {
    const engine = new ContextEngine({
      store,
      chatId: 'chat-123',
      userId: 'user-456',
    });
    engine.set(...fragments);
    return engine;
  },
});

// Generate SQL
const sql = await text2sql.toSql('Show me the top 10 customers by revenue');
console.log(sql);
```

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Experimental: Text2SqlV3

Use `Text2SqlV3` when you already own the bash sandbox and want to mount the
`sql` subcommand into that sandbox yourself instead of letting `Text2Sql`
create its own internal result tools. See [sqlv3.md](./sqlv3.md) for the
caller-owned sandbox setup and the behavior differences from v1.

## Fragments

Inject domain knowledge using fragments from `@deepagents/context` inside the
`context` factory you pass to `Text2Sql`. Those fragments affect `chat()`
sessions. If you need direct SQL generation with extra fragments, use the
lower-level `toSql({ fragments })` helper exported from `@deepagents/text2sql`.

```typescript
import {
  ContextEngine,
  InMemoryContextStore,
  example,
  guardrail,
  hint,
  term,
} from '@deepagents/context';

const store = new InMemoryContextStore();

const context = (...fragments) => {
  const engine = new ContextEngine({
    store,
    chatId: 'chat-123',
    userId: 'user-456',
  });

  engine.set(
    term('MRR', 'monthly recurring revenue'),
    hint('Always exclude test accounts with email ending in @test.com'),
    guardrail({
      rule: 'Never expose individual salaries',
      reason: 'Confidential HR data',
      action: 'Aggregate by department instead',
    }),
    example({
      question: 'show me churned customers',
      answer: `SELECT * FROM customers WHERE status = 'churned' ORDER BY churned_at DESC`,
    }),
    ...fragments,
  );

  return engine;
};
```

**Domain fragments** (11 types): `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`, `glossary`.

**User fragments** (5 types): `identity`, `persona`, `alias`, `preference`, `correction`.

See [@deepagents/context](../context/README.md) for full fragment documentation.

## Grounding

Control what schema metadata the AI receives:

| Function         | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `tables()`       | Tables, columns, and primary keys                         |
| `views()`        | Database views                                            |
| `info()`         | Database version and info                                 |
| `indexes()`      | Index information for performance hints                   |
| `constraints()`  | Foreign keys and other constraints                        |
| `rowCount()`     | Table sizes (tiny, small, medium, large, huge)            |
| `columnStats()`  | Min/max/null distribution for columns                     |
| `columnValues()` | Enum-like and low-cardinality columns with sampled values |

## Conversations

`chat()` persists history through the `ContextEngine` returned by your `context` factory. Reuse the same store, `chatId`, and `userId` to continue the same thread:

```typescript
const stream = await text2sql.chat([
  { role: 'user', content: 'Show me orders from last month' },
]);

for await (const chunk of stream) {
  // handle streaming response
}

// Continue the same conversation
const followUp = await text2sql.chat([
  { role: 'user', content: 'Now filter to only completed ones' },
]);
```

`toSql()` is stateless. It reads the current schema fragments, but it does not
write messages, titles, or usage into your context store.

## Direct SQL Generation with Extra Fragments

```typescript
import { term } from '@deepagents/context';
import { toSql } from '@deepagents/text2sql';

const result = await toSql({
  input: 'Show ARR by plan',
  adapter,
  model: groq('openai/gpt-oss-20b'),
  fragments: [
    ...(await adapter.introspect()),
    term('ARR', 'annual recurring revenue'),
  ],
});

console.log(result.sql);
```

## Documentation

Full documentation available at [januarylabs.github.io/deepagents](https://januarylabs.github.io/deepagents/docs/text2sql):

- [Getting Started](https://januarylabs.github.io/deepagents/docs/text2sql/getting-started)
- [Generate SQL](https://januarylabs.github.io/deepagents/docs/text2sql/to-sql)
- [Text2SqlV3 (Experimental)](https://januarylabs.github.io/deepagents/docs/text2sql/sqlv3)
- [Teach the System](https://januarylabs.github.io/deepagents/docs/text2sql/teach-the-system)
- [Build Conversations](https://januarylabs.github.io/deepagents/docs/text2sql/build-conversations)
- [Grounding](https://januarylabs.github.io/deepagents/docs/text2sql/grounding)
- [PostgreSQL](https://januarylabs.github.io/deepagents/docs/text2sql/postgresql)
- [SQLite](https://januarylabs.github.io/deepagents/docs/text2sql/sqlite)
- [SQL Server](https://januarylabs.github.io/deepagents/docs/text2sql/sqlserver)
- [MySQL / MariaDB](https://januarylabs.github.io/deepagents/docs/text2sql/mysql)
- [BigQuery](https://januarylabs.github.io/deepagents/docs/text2sql/bigquery)

## Repository

[github.com/JanuaryLabs/deepagents](https://github.com/JanuaryLabs/deepagents)
