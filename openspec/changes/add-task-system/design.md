## Context

`@deepagents/context` has two store patterns: `ContextStore` (complex DAG for conversations — chats, messages, branches, checkpoints across 4+ tables) and `StreamStore` (simple CRUD for stream lifecycle — single entity type, 2 tables). The task system is a new persistent store for structured work tracking, closer in complexity to `StreamStore` than `ContextStore`.

The existing codebase conventions:

- `SqliteContextStore` and `SqliteStreamStore` both use `node:sqlite` `DatabaseSync`, prepared statement caching via `#stmt()`, DDL imported from `.sql` files, and accept `pathOrDb: string | DatabaseSync`
- `InMemoryContextStore` wraps `SqliteContextStore` with `':memory:'`
- Abstract base classes define the contract; SQLite is the primary implementation

## Goals / Non-Goals

**Goals:**

- Abstract `TaskStore` class defining CRUD, listing, and dependency operations
- `SqliteTaskStore` using `node:sqlite` with prepared statement caching
- `InMemoryTaskStore` wrapping SQLite `:memory:` for tests
- Context-efficient listing (omit heavy fields by default)
- DAG dependency resolution with automatic availability computation
- Pre-built AI SDK tools accepting a `TaskStore` instance
- Fragment builders for system prompt injection

**Non-Goals:**

- PostgreSQL/MSSQL task store implementations (can follow later using same abstract class)
- File-based persistence (Claude Code uses JSON files; we use SQLite which is strictly better)
- Multi-process file locking (Agent Teams concern; out of scope for this store)
- Integration with ContextEngine (tasks are standalone; engine integration can come later)
- UI rendering layer (terminal spinners etc. — consumer responsibility)

## Decisions

### 1. Single `tasks` table with JSON columns for arrays

**Choice:** One table: `tasks(id, listId, subject, description, status, owner, activeForm, blockedBy, blocks, metadata, createdAt, updatedAt)`. `blockedBy`, `blocks`, and `metadata` stored as JSON text.

**Why:** Tasks are flat records, not a graph. A normalized `task_dependencies` junction table adds complexity with no benefit — dependency lists are small (typically 0-5 items) and always read/written as a whole. JSON columns are simple, queryable with `json_each()` in SQLite, and match how consumers think about the data.

**Alternative considered:** Normalized junction table for dependencies — rejected because it adds 2 extra tables, requires JOINs on every list query, and the dependency sets are small enough that JSON is fine.

### 2. Mirror StreamStore pattern

**Choice:** Follow `StreamStore`/`SqliteStreamStore` conventions: abstract class with `async` methods, `#db`/`#stmt()` caching, `constructor(pathOrDb)`, DDL from `.sql` import.

**Why:** StreamStore is the closest existing pattern (simple CRUD for a single entity type). ContextStore is far more complex (DAG traversal, branches, checkpoints). Consistency with existing codebase patterns reduces cognitive load.

### 3. `listId` scoping for multi-session support

**Choice:** Every task belongs to a `listId` (string). All queries are scoped by `listId`. This mirrors Claude Code's `CLAUDE_CODE_TASK_LIST_ID` — different sessions/agents can maintain isolated task lists in the same database.

**Why:** Without scoping, a shared SQLite file would mix tasks from unrelated sessions. `listId` provides namespace isolation without requiring separate database files.

### 4. `listTasks` omits `description` and `metadata`

**Choice:** `listTasks()` returns `TaskSummary` (id, listId, subject, status, owner, activeForm, blockedBy, blocks, createdAt, updatedAt) — deliberately excluding `description` and `metadata`. `getTask()` returns full `TaskData`.

**Why:** Direct lesson from Claude Code's architecture. When the LLM calls TaskList, it gets a compact overview. For full details, it must call TaskGet per task. This N+1 pattern saves potentially thousands of context tokens — a 50-task project plan with detailed descriptions could consume 10K+ tokens if returned in full.

### 5. Availability computed at query time via `listAvailableTasks`

**Choice:** Separate method `listAvailableTasks(listId)` that filters: `status='pending' AND owner IS NULL AND all blockedBy tasks have status='completed'`. Implemented as a SQL subquery using `json_each()`.

**Why:** No separate "available" flag to keep in sync. Availability is a derived property. Computing it at query time guarantees consistency — when a blocking task completes, dependent tasks become immediately available without an explicit update step.

### 6. Tools accept `TaskStore` instance via factory function

**Choice:** `createTaskTools(store: TaskStore, listId: string)` returns `{ taskCreate, taskUpdate, taskList, taskGet }` — standard AI SDK `ToolSet`. The factory closes over the store and listId.

**Why:** Decouples tool definitions from store construction. Consumers wire the store however they want (shared SQLite, in-memory for tests, future Postgres) and pass it to the factory. No dependency on `@deepagents/agent` — these are pure Vercel AI SDK tools.

### 7. Fragment builders are pure functions

**Choice:** `taskFragment(task: TaskData): ContextFragment` and `tasksFragment(tasks: TaskData[]): ContextFragment` convert task data into nested fragments renderable via `render()`.

**Why:** Keeps the fragment layer decoupled from the store layer. Consumers can call `listTasks()` → `tasksFragment(results)` → `render('tasks', fragment)` to inject task state into any system prompt.

## Risks / Trade-offs

**JSON columns for `blockedBy`/`blocks` limit query expressiveness** → Mitigated by `json_each()` for availability queries. For the expected scale (tens of tasks, not millions), JSON parsing overhead is negligible.

**N+1 query pattern for full task details** → Intentional tradeoff: saves context tokens at the cost of extra tool calls. The LLM typically only needs full details for 1-2 tasks at a time (the ones it's actively working on).

**No cross-process locking** → Out of scope. If two processes share a SQLite file, SQLite's built-in file-level locking handles concurrent writes. For true multi-agent coordination, consumers should use a shared SQLite WAL-mode database or future Postgres implementation.

**`listId` is a flat string, not hierarchical** → Sufficient for session isolation. Hierarchical namespacing (team/project/session) can be achieved by convention in the `listId` value (e.g., `team-alpha/project-x`).
