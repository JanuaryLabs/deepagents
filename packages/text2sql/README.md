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

Requires Node.js LTS

## Quick Start

```typescript
import { groq } from '@ai-sdk/groq';
import pg from 'pg';

import { FileIndexLock, Text2Sql } from '@deepagents/text2sql';
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
  model: groq('openai/gpt-oss-20b'),
  adapters: { main: adapter },
  lock: new FileIndexLock(),
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
`sql run <db> "..."` calls from a sandbox where the package CLI is installed.
This is the configured connection name, not the SQL-level database or schema
name (for example, SQLite's default `main` schema).

Adapter names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. If you build adapter
maps dynamically, use `isValidAdapterName(name)` to check one key or
`validateAdapterNames(names)` to fail fast before constructing `Text2Sql` or
the sandbox-side adapter module used by the `sql` CLI.

## AI Model Providers

Text2SQL works with any model provider supported by the [Vercel AI SDK](https://sdk.vercel.ai/docs), including OpenAI, Anthropic, Google, Groq, and more.

## Building a Conversational Agent

`Text2Sql` owns SQL generation and schema indexing, but you own the chat loop.
Build the agent by composing a `ContextEngine`, a sandbox, and `agent` +
`chat` from `@deepagents/context`:

```typescript
import {
  ContextEngine,
  type ContextFragment,
  InMemoryContextStore,
  agent,
  chat,
  createBashTool,
  createDockerSandbox,
  errorRecoveryGuardrail,
  npm,
  user,
} from '@deepagents/context';
import { createSqlCommandHooks, instructions } from '@deepagents/text2sql';

const store = new InMemoryContextStore();
const context = new ContextEngine({
  store,
  chatId: 'chat-123',
  userId: 'user-456',
});

const backend = await createDockerSandbox({
  installers: [npm('@deepagents/text2sql', { ensureRuntime: true })],
  volumes: [
    {
      type: 'bind',
      hostPath: process.cwd(),
      containerPath: '/workspace',
      readOnly: true,
    },
  ],
  env: {
    TEXT2SQL_ADAPTERS: '/workspace/text2sql-adapters.ts',
  },
});
const sandbox = await createBashTool({
  sandbox: backend,
  ...createSqlCommandHooks({ adapters: { main: adapter } }),
});

const indexResult = await sandbox.sandbox.executeCommand('sql index');
if (indexResult.exitCode !== 0) throw new Error(indexResult.stderr);
const manifest = JSON.parse(indexResult.stdout) as { fragmentsPath: string };
const fragments = JSON.parse(
  await sandbox.sandbox.readFile(manifest.fragmentsPath),
) as ContextFragment[];
context.set(...instructions(), ...fragments);

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

The `/workspace/text2sql-adapters.ts` module must exist in the sandbox and
default-export your adapter map. Mount your project into `/workspace` (as above)
or upload/write that module before you call `sql index` or `chat()`.

`instructions()` returns the SQL-flavored system fragments (policies, workflows,
clarifications, style guides) — spread them into `context.set()` alongside the
schema fragments returned by `sql index`. The index output starts with an
`available_databases` fragment that lists the exact configured adapter names the
model must pass to `sql validate <db>` and `sql run <db>`. Add or replace the
instructions with your own domain fragments as needed.

## Advanced: SQL CLI in Sandboxes

`sql validate <db> "..."` and `sql run <db> "..."` are real commands from the
`@deepagents/text2sql` package. `<db>` is the configured adapter name. With a
single configured adapter, a mistaken database selector is routed to that sole
adapter and the command prints a note; with multiple adapters, unknown names
fail and print the available list. `sql index` writes an `available_databases`
fragment, schema fragments, and progress events for chat setup, indexing all
configured adapters by default (same as `--all`) unless adapter names are
provided.

Install the package inside the sandbox and set `TEXT2SQL_ADAPTERS` to a module
whose default export is `Record<string, Adapter>`. Missing `sql` means the
sandbox was not prepared correctly.

`sql index` output details:

- `stdout`: JSON manifest with `fragmentsPath`, `eventsPath`, adapters, and
  fragment count.
- `--verbose pretty` or `--verbose json`: mirrors progress events to `stderr`
  while keeping `stdout` as the manifest.
- `--out-dir <path>`: writes artifacts under that path (default:
  `$TEXT2SQL_OUT_DIR` or `./sql`).

The `sql` CLI caches introspected schema only when you opt in via env: set
`TEXT2SQL_INDEX_CACHE_DIR` (where cache files live) and/or
`TEXT2SQL_INDEX_VERSION` (an invalidation token — bump it when the schema
changes). With neither set, every `sql index` introspects fresh. See
[Schema index caching & coordination](#schema-index-caching--coordination) for
the underlying injectable primitives.

For in-process or virtual-sandbox usage (without installing the package CLI),
wrap an existing `Text2Sql` instance as a just-bash custom command:

```typescript
import { InMemoryFs, createVirtualSandbox } from '@deepagents/context';
import {
  type CreateSqlCommandOptions,
  type CreateSqlCommandResult,
  FileIndexLock,
  Text2Sql,
  createSqlCommand,
} from '@deepagents/text2sql';

const text2sql = new Text2Sql({
  model,
  adapters: { main: adapter },
  lock: new FileIndexLock(),
});

const commandOptions: CreateSqlCommandOptions = {
  outputDir: '/sql-artifacts',
};
const sqlCommand: CreateSqlCommandResult = createSqlCommand(
  text2sql,
  commandOptions,
);

const sandbox = await createVirtualSandbox({
  fs: new InMemoryFs(),
  customCommands: [sqlCommand.command],
});

await sandbox.executeCommand('sql validate main "SELECT 1"');
```

`CreateSqlCommandOptions` configures command defaults (currently `outputDir`).
`CreateSqlCommandResult` returns the command plus a `repair(raw)` helper for
normalizing model-generated argv before execution.

Spread `createSqlCommandHooks({ adapters })` into `createBashTool()` for
model-driven bash calls. The before hook preserves
the old virtual-command tolerance for common LLM quote mistakes, rewrites SQL
identifier backticks so bash does not run them as command substitutions, and
blocks raw database access so read-only and scope checks stay behind
`sql validate` / `sql run`. The after hook restores hidden `formattedSql`
metadata from the host adapter map without putting that concern into the real
CLI.

Read-only enforcement accepts a single `SELECT`/`WITH` statement even when it
starts with whitespace or SQL comments (`-- ...`, `/* ... */`). It still
rejects comment-only input, multi-statement batches, and write operations.

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

## Schema index caching & coordination

Schema introspection is the expensive part of indexing. `Text2Sql` and
`AdapterIndexer` own no storage and no locking — you inject them, keyed per
adapter. A `lock` is **required**; a `cache` is optional:

```typescript
export interface IndexCache {
  read(key: string): Promise<ContextFragment[] | null>;
  write(key: string, fragments: ContextFragment[]): Promise<void>;
}

export interface IndexLock {
  // Acquire (waiting if held elsewhere), run fn, release — even on throw.
  // Reject if the lock can't be acquired (callers fail closed).
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
```

- **`lock` only** (no `cache`) → introspection is serialized but not
  deduplicated: each waiter re-introspects, because the cache recheck under the
  lock is what turns serialization into single-flight.
- **`lock` + `cache`** → introspection is single-flight: concurrent callers for
  the same adapter wait on the lock, then read the warm cache the holder wrote.

File-backed `IndexCache` and `IndexLock` implementations ship as composable
primitives:

```typescript
import { FileIndexCache, FileIndexLock, Text2Sql } from '@deepagents/text2sql';

const text2sql = new Text2Sql({
  model,
  adapters: { main: adapter },
  // Point both `dir`s at a shared volume to share one cache + lock across
  // processes on the same filesystem.
  cache: new FileIndexCache({ dir: '/var/cache/text2sql', namespace: 'v1' }),
  lock: new FileIndexLock({ dir: '/var/cache/text2sql', namespace: 'v1' }),
});
```

`FileIndexCache` writes atomically (temp + rename) and treats an unparseable
file as a miss, so a torn read self-heals into a re-introspect. `FileIndexLock`
(built on `proper-lockfile`, options `{ dir?, namespace?, stale?, retries? }`)
serializes processes that share a POSIX filesystem; a held lock auto-refreshes
its mtime so a slow introspection is not mistaken for a crash, and acquisition
fails closed once retries are exhausted. Both `dir`s default to the OS temp
directory.

### Horizontally-scaled deployments

Running many processes/containers against one database (e.g. a fleet of
daemons)? Two coordination tiers:

- The **lock alone** serializes introspection — never two concurrent
  introspections of the same database (caps peak DB load). The shipped
  `FileIndexLock` covers processes that share a POSIX filesystem (one host, or a
  shared volume — NFSv4 / EFS); for hosts without a shared filesystem, back it
  with a distributed lock you already operate (a Redis lock, a Postgres
  `pg_advisory_lock`, etc.).
- The **lock plus a shared cache directory** gives fleet-wide single-flight:
  the lock holder writes the cache on the shared volume, and every waiter reads
  it instead of re-introspecting.

> On object-storage-backed volumes (GCS/S3 FUSE) `rename` is not atomic and
> file locks are unreliable — that is exactly why the lock and cache are
> injectable. Use a real distributed lock; the `FileIndexCache` parse-as-miss
> behavior plus the post-lock recheck tolerate a non-atomic write.

See `demo/text2sql-daemon` for a daemon that injects a `FileIndexCache`
(`TEXT2SQL_INDEX_CACHE_DIR` / `TEXT2SQL_INDEX_VERSION`) and a `pg_advisory_lock`
backed `IndexLock`.

## Streaming Index Progress

`AdapterIndexer#index({ onProgress })` emits progress events while it warms or reads
the schema cache for host-side indexing. The sandbox CLI writes the same event
shape to the `eventsPath` file returned by `sql index`:

```typescript
import { createUIMessageStream } from 'ai';

import {
  AdapterIndexer,
  FileIndexLock,
  TEXT2SQL_INDEX_PROGRESS_CHUNK,
  type Text2SqlIndexProgressEvent,
} from '@deepagents/text2sql';

const indexer = new AdapterIndexer({ adapters, lock: new FileIndexLock() });

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

    const fragments = await indexer.index({
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
- [Agent + SQLite Store Recipe](https://januarylabs.github.io/deepagents/docs/text2sql/recipes/agent-sqlite-store)
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
