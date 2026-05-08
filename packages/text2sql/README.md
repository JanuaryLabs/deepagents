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

Install the database driver or client library that matches your adapter:

```bash
npm install pg                       # PostgreSQL
npm install mssql                    # SQL Server
npm install mysql2                   # MySQL / MariaDB
npm install @google-cloud/bigquery   # BigQuery
```

Requires Node.js LTS (20+).

## Quick Start

```typescript
import { groq } from '@ai-sdk/groq';
import { InMemoryFs } from 'just-bash';
import pg from 'pg';

import {
  ContextEngine,
  InMemoryContextStore,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
} from '@deepagents/context';
import { Text2Sql, sqlSandboxExtension } from '@deepagents/text2sql';
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
  adapters: { main: adapter },
});

// Generate SQL
const sql = await text2sql.toSql(
  'Show me the top 10 customers by revenue',
  'main',
);
console.log(sql);
```

The adapter-map key (`main` here) is the adapter name. Reuse that same key in
`text2sql.toSql(..., 'main')` and in any `sql validate <db> "..."` /
`sql run <db> "..."` sandbox calls.

Adapter names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. If you build adapter
maps dynamically, use `isValidAdapterName(name)` to check one key or
`validateAdapterNames(names)` to fail fast before constructing `Text2Sql` or
`sqlSandboxExtension`.

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Building a Conversational Agent

`Text2Sql` ships only the SQL-aware primitives — `toSql`, `index`, `toPairs`,
and `instructions()`. You build the chat agent yourself by composing a
`ContextEngine`, a sandbox, and `agent` + `chat` from `@deepagents/context`:

```typescript
import { InMemoryFs } from 'just-bash';

import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createRoutingSandbox,
  createVirtualSandbox,
  errorRecoveryGuardrail,
  user,
} from '@deepagents/context';
import {
  Text2Sql,
  instructions,
  sqlSandboxExtension,
} from '@deepagents/text2sql';

const store = new InMemoryContextStore();
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

const sandbox = await createBashTool({
  sandbox: await createRoutingSandbox({
    backend: await createVirtualSandbox({ fs: new InMemoryFs() }),
    hostExtensions: [sqlSandboxExtension({ main: adapter })],
  }),
});

context.set(...instructions(), ...(await text2sql.index()));

const ai = agent({
  name: 'sql-assistant',
  sandbox,
  model: groq('openai/gpt-oss-20b'),
  context,
  guardrails: [errorRecoveryGuardrail],
  maxGuardrailRetries: 3,
});

await context.continue(user('Show me the top 10 customers by revenue'));
const stream = await chat(ai);

for await (const chunk of stream) {
  // handle streaming response
}
```

`instructions()` returns the SQL-flavored system fragments (policies, workflows,
clarifications, style guides) — spread them into `context.set()` alongside the
schema fragments returned by `text2sql.index()`. Add or replace them with your
own domain fragments as needed.

## Advanced: Composing Sandbox Extensions

`sqlSandboxExtension(adaptersMap)` returns a `SandboxExtension` that bundles the
`sql` subcommand, transform plugins, and arg-repair hook. In the simplest case,
that map is `{ main: adapter }`. Compose it (alongside any of your own
extensions) via `createBashTool` + `createRoutingSandbox` + `createVirtualSandbox`.
See [Caller-Owned Sandbox](https://januarylabs.github.io/deepagents/docs/text2sql/sqlv3)
for composition patterns.

## Fragments

Inject domain knowledge by setting fragments on the `ContextEngine` you build
for the agent. Those fragments affect every `chat()` turn. If you need direct
SQL generation with extra fragments, use the lower-level `toSql({ fragments })`
helper exported from `@deepagents/text2sql`.

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
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

context.set(
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
);
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

`chat()` (from `@deepagents/context`) persists history through the
`ContextEngine` you build for the agent. Reuse the same store, `chatId`, and
`userId` to continue the same thread. Before each turn, append only the new
incoming message to the engine; do not replay earlier turns that are already
stored in the context store:

```typescript
await context.continue(user('Show me orders from last month'));
const stream = await chat(ai);

for await (const chunk of stream) {
  // handle streaming response
}

// Continue the same conversation
await context.continue(user('Now filter to only completed ones'));
const followUp = await chat(ai);
for await (const chunk of followUp) {
  // handle streaming response
}
```

## Streaming Index Progress

`text2sql.index({ onProgress })` emits progress events while it warms or reads
the schema cache. To interleave those events with the chat stream so a UI can
render indexing status before assistant text starts, wrap the loop in your own
`createUIMessageStream`:

```typescript
import { createUIMessageStream } from 'ai';

import {
  TEXT2SQL_INDEX_PROGRESS_CHUNK,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';

await context.continue(user('Show me top 10 customers'));

const stream = createUIMessageStream({
  execute: async ({ writer }) => {
    const head = await context.headMessage();
    if (!head || head.name !== 'assistant') {
      throw new Error(
        'expected head to be an assistant message — call context.continue() before chat()',
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

    context.set(...instructions(), ...fragments);
    writer.merge(await chat(ai));
  },
});
```

Each progress event includes a generic Unix epoch `timestampMs` so clients can
calculate per-index, per-adapter, or per-phase durations without Text2SQL
imposing one duration policy.

`toSql()` is stateless. It reads the current schema fragments, but it does not
write messages, titles, or usage into your context store.

## Direct SQL Generation with Extra Fragments

This lower-level helper still takes a single `adapter` because it bypasses the
multi-adapter `Text2Sql` wrapper entirely.

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
- [Caller-Owned Sandbox](https://januarylabs.github.io/deepagents/docs/text2sql/sqlv3)
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
