# @deepagents/text2sql

AI-powered natural language to SQL. Ask questions in plain English, get executable queries.

## Features

- **Natural Language to SQL** - Convert questions to validated, executable queries
- **Multi-Database Support** - PostgreSQL, SQLite, and SQL Server adapters
- **Schema-Aware** - Automatic introspection of tables, relationships, indexes, and constraints
- **Domain Knowledge** - Teach business terms, guardrails, and query patterns via teachables
- **Conversational** - Multi-turn conversations with history and user memory
- **Explainable** - Convert SQL back to plain English explanations
- **Safe by Default** - Read-only queries, validation, and configurable guardrails

## Installation

```bash
npm install @deepagents/text2sql
```

Requires Node.js LTS (20+).

## Quick Start

```typescript
import pg from 'pg';
import {
  Text2Sql,
  Postgres,
  InMemoryHistory,
} from '@deepagents/text2sql';
import * as postgres from '@deepagents/text2sql/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const text2sql = new Text2Sql({
  version: 'v1',
  adapter: new Postgres({
    execute: async (sql) => {
      const result = await pool.query(sql);
      return result.rows;
    },
    grounding: [
      postgres.tables(),
      postgres.views(),
      postgres.info(),
      postgres.indexes(),
      postgres.constraints(),
      postgres.lowCardinality(),
    ],
  }),
  history: new InMemoryHistory(),
});

// Generate SQL without executing
const { generate } = await text2sql.toSql('Show me the top 10 customers by revenue');
const sql = await generate();
console.log(sql);

// Generate and execute with streaming
const stream = await text2sql.single('What are the most popular products?');
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.textDelta);
  }
}
```

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Teachables

Inject domain knowledge to improve query accuracy:

```typescript
import { term, hint, guardrail, example } from '@deepagents/text2sql';

text2sql.instruct(
  term('MRR', 'monthly recurring revenue'),
  hint('Always exclude test accounts with email ending in @test.com'),
  guardrail({
    rule: 'Never expose individual salaries',
    reason: 'Confidential HR data',
    action: 'Aggregate by department instead',
  }),
  example({
    question: 'show me churned customers',
    sql: `SELECT * FROM customers WHERE status = 'churned' ORDER BY churned_at DESC`,
  }),
);
```

10 teachable types available: `term`, `hint`, `guardrail`, `example`, `explain`, `clarification`, `workflow`, `quirk`, `styleGuide`, `analogy`.

## Grounding

Control what schema metadata the AI receives:

| Function | Description |
|----------|-------------|
| `tables()` | Tables, columns, and primary keys |
| `views()` | Database views |
| `info()` | Database version and info |
| `indexes()` | Index information for performance hints |
| `constraints()` | Foreign keys and other constraints |
| `rowCount()` | Table sizes (tiny, small, medium, large, huge) |
| `columnStats()` | Min/max/null distribution for columns |
| `lowCardinality()` | Enum-like columns with distinct values |

## Conversations

Build multi-turn conversations with context:

```typescript
const chat = text2sql.chat([
  { role: 'user', content: 'Show me orders from last month' },
]);

for await (const chunk of chat) {
  // handle streaming response
}

// Continue the conversation
const followUp = text2sql.chat([
  { role: 'user', content: 'Now filter to only completed ones' },
], { chatId: chat.id });
```

## Explain Queries

Convert SQL to plain English:

```typescript
const explanation = await text2sql.explain(`
  SELECT department, AVG(salary)
  FROM employees
  GROUP BY department
`);
// "This query calculates the average salary for each department..."
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
