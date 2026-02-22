## Why

`@deepagents/context` provides context fragments, persistence (ContextStore), and streaming (StreamStore), but has no task management primitive. Agents building multi-step workflows need structured work tracking with dependencies, persistent state that survives context compaction, and context-efficient access patterns. Today, every consumer must reinvent task tracking ad-hoc. A first-class task system — modeled after Claude Code's proven architecture — gives agents externalized memory for work coordination, DAG-based dependency resolution, and ready-made AI SDK tools.

## What Changes

- New abstract `TaskStore` class following the same pattern as `ContextStore` and `StreamStore` — defines the storage contract for task CRUD, dependency tracking, and listing
- `SqliteTaskStore` implementation using `node:sqlite` (zero external deps), matching `SqliteContextStore` conventions
- `InMemoryTaskStore` wrapping SQLite `:memory:` for tests, matching `InMemoryContextStore`
- DAG dependency engine: `blockedBy`/`blocks` fields with automatic availability resolution (a task is available when all blockers are completed)
- Context-efficient `listTasks()` that omits `description` and `metadata` by default (N+1 pattern — call `getTask()` for full details)
- Task fragment builders for injecting current task state into system prompts via `fragment()`
- Pre-built AI SDK tool definitions (`taskCreate`, `taskUpdate`, `taskList`, `taskGet`) ready to wire into any agent's `tools` config

## Capabilities

### New Capabilities

- `task-store`: Abstract TaskStore interface + SqliteTaskStore + InMemoryTaskStore — persistent task CRUD with status lifecycle (pending → in_progress → completed → deleted), owner tracking, arbitrary metadata, and timestamp management
- `task-dependencies`: Directed acyclic graph via blockedBy/blocks fields — automatic availability resolution on list queries, topological ordering support, and circular dependency prevention
- `task-tools`: Pre-built Vercel AI SDK tool definitions (taskCreate, taskUpdate, taskList, taskGet) with Zod schemas, ready to pass into any agent's tools config
- `task-fragments`: Fragment builders that convert task state into ContextFragments for system prompt injection via the existing render() pipeline

### Modified Capabilities

_(none)_

## Impact

- **Code**: New directory `packages/context/src/lib/tasks/` containing store abstraction, SQLite implementation, tool definitions, and fragment builders. New exports from `packages/context/src/index.ts`
- **Dependencies**: Uses existing `node:sqlite` — no new packages required
- **APIs**: New exports (`TaskStore`, `SqliteTaskStore`, `InMemoryTaskStore`, `taskTools`, `taskFragment`); no changes to existing APIs
- **Composability**: Works standalone or alongside ContextEngine. Tasks can be rendered as fragments via the existing XmlRenderer/MarkdownRenderer pipeline
