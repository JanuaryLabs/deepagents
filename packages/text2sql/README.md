# @deepagents/text2sql

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

## Features

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, and SQL Server adapters
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
import pg from 'pg';

import { InMemoryContextStore } from '@deepagents/context';
import { Text2Sql } from '@deepagents/text2sql';
import {
  Postgres,
  constraints,
  indexes,
  info,
  lowCardinality,
  tables,
  views,
} from '@deepagents/text2sql/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const text2sql = new Text2Sql({
  version: 'v1',
  model: groq('gpt-oss-20b'),
  adapter: new Postgres({
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
      lowCardinality(),
    ],
  }),
  store: new InMemoryContextStore(),
});

// Generate SQL
const sql = await text2sql.toSql('Show me the top 10 customers by revenue');
console.log(sql);
```

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Fragments

Inject domain knowledge using fragments from `@deepagents/context` to improve query accuracy. Pass instructions via the constructor:

```typescript
import { example, guardrail, hint, term } from '@deepagents/context';

const text2sql = new Text2Sql({
  // ... other config
  instructions: [
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
  ],
});
```

**Domain fragments** (11 types): `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`, `glossary`.

**User fragments** (6 types): `identity`, `persona`, `alias`, `preference`, `userContext`, `correction`.

See [@deepagents/context](../context/README.md) for full fragment documentation.

## Grounding

Control what schema metadata the AI receives:

| Function           | Description                                    |
| ------------------ | ---------------------------------------------- |
| `tables()`         | Tables, columns, and primary keys              |
| `views()`          | Database views                                 |
| `info()`           | Database version and info                      |
| `indexes()`        | Index information for performance hints        |
| `constraints()`    | Foreign keys and other constraints             |
| `rowCount()`       | Table sizes (tiny, small, medium, large, huge) |
| `columnStats()`    | Min/max/null distribution for columns          |
| `lowCardinality()` | Enum-like columns with distinct values         |

## Conversations

Build multi-turn conversations with context:

```typescript
const chatId = 'chat-123';
const userId = 'user-456';

const stream = await text2sql.chat(
  [{ role: 'user', content: 'Show me orders from last month' }],
  { chatId, userId },
);

for await (const chunk of stream) {
  // handle streaming response
}

// Continue the conversation with the same chatId
const followUp = await text2sql.chat(
  [{ role: 'user', content: 'Now filter to only completed ones' }],
  { chatId, userId },
);
```

## Documentation

Full documentation available at [januarylabs.github.io/deepagents](https://januarylabs.github.io/deepagents/docs/text2sql):

- [Getting Started](https://januarylabs.github.io/deepagents/docs/text2sql/getting-started)
- [Generate SQL](https://januarylabs.github.io/deepagents/docs/text2sql/generate-sql)
- [Teach the System](https://januarylabs.github.io/deepagents/docs/text2sql/teach-the-system)
- [Build Conversations](https://januarylabs.github.io/deepagents/docs/text2sql/build-conversations)
- [Grounding](https://januarylabs.github.io/deepagents/docs/text2sql/grounding)
- [PostgreSQL](https://januarylabs.github.io/deepagents/docs/text2sql/postgresql)
- [SQLite](https://januarylabs.github.io/deepagents/docs/text2sql/sqlite)
- [SQL Server](https://januarylabs.github.io/deepagents/docs/text2sql/sqlserver)

## Repository

[github.com/JanuaryLabs/deepagents](https://github.com/JanuaryLabs/deepagents)
