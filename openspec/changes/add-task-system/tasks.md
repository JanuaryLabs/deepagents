## 1. Store Abstraction

- [ ] 1.1 Create `packages/context/src/lib/tasks/task-store.ts` with `TaskStatus` type (`'pending' | 'in_progress' | 'completed' | 'deleted'`), `TaskData` interface (full record with all fields), `TaskSummary` interface (omits `description` and `metadata`), `CreateTaskData` interface (input for creation), `UpdateTaskData` interface (partial update input with `addBlockedBy`, `addBlocks`, `removeBlockedBy`, `removeBlocks`)
- [ ] 1.2 Define abstract `TaskStore` class with methods: `createTask(data: CreateTaskData): Promise<TaskData>`, `getTask(taskId: string): Promise<TaskData | undefined>`, `updateTask(taskId: string, updates: UpdateTaskData): Promise<TaskData | undefined>`, `deleteTask(taskId: string): Promise<boolean>`, `listTasks(listId: string): Promise<TaskSummary[]>`, `listAvailableTasks(listId: string): Promise<TaskSummary[]>`

## 2. SQLite Implementation

- [ ] 2.1 Create `packages/context/src/lib/tasks/ddl.task.sqlite.sql` with `tasks` table: `id TEXT`, `listId TEXT`, `subject TEXT`, `description TEXT`, `status TEXT DEFAULT 'pending'`, `owner TEXT`, `activeForm TEXT`, `blockedBy TEXT DEFAULT '[]'`, `blocks TEXT DEFAULT '[]'`, `metadata TEXT`, `createdAt INTEGER`, `updatedAt INTEGER`. Primary key on `(id, listId)`. Index on `(listId, status)`. Index on `(listId, createdAt)`.
- [ ] 2.2 Create `packages/context/src/lib/tasks/sqlite.task-store.ts` with `SqliteTaskStore extends TaskStore`. Constructor accepts `pathOrDb: string | DatabaseSync`. Uses `#db`, `#stmt()` caching pattern from `SqliteStreamStore`. Runs DDL on construction. Auto-generates string IDs via `SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 FROM tasks WHERE listId = ?`.
- [ ] 2.3 Implement `createTask` — insert with auto-ID, JSON.stringify for `blockedBy`/`blocks`/`metadata`, return full `TaskData`
- [ ] 2.4 Implement `getTask` — select by `id`, JSON.parse array/object fields, return `TaskData` or `undefined`
- [ ] 2.5 Implement `updateTask` — read existing, merge updates, handle `addBlockedBy`/`addBlocks` (append without duplicates), handle `removeBlockedBy`/`removeBlocks`, update `updatedAt`, return updated `TaskData`
- [ ] 2.6 Implement `deleteTask` — delete by `id`, return boolean
- [ ] 2.7 Implement `listTasks` — select `id, listId, subject, status, owner, activeForm, blockedBy, blocks, createdAt, updatedAt` where `listId = ? AND status != 'deleted'` ordered by `createdAt ASC`, JSON.parse arrays, return `TaskSummary[]`
- [ ] 2.8 Implement `listAvailableTasks` — filter `listTasks` result: `status = 'pending' AND owner IS NULL AND all blockedBy task IDs have status = 'completed'`

## 3. InMemoryTaskStore

- [ ] 3.1 Create `packages/context/src/lib/tasks/memory.task-store.ts` with `InMemoryTaskStore extends SqliteTaskStore` — constructor calls `super(':memory:')`

## 4. AI SDK Tools

- [ ] 4.1 Create `packages/context/src/lib/tasks/task-tools.ts` with `createTaskTools(store: TaskStore, listId: string)` factory function
- [ ] 4.2 Implement `taskCreate` tool — Zod schema: `{ subject: z.string(), description: z.string(), activeForm: z.string(), blockedBy: z.array(z.string()).optional(), metadata: z.record(z.unknown()).optional() }`. Execute calls `store.createTask()`, returns `{ id, subject }`
- [ ] 4.3 Implement `taskUpdate` tool — Zod schema: `{ taskId: z.string(), status: z.enum([...]).optional(), subject: z.string().optional(), description: z.string().optional(), owner: z.string().optional(), addBlockedBy: z.array(z.string()).optional(), addBlocks: z.array(z.string()).optional(), removeBlockedBy: z.array(z.string()).optional(), removeBlocks: z.array(z.string()).optional() }`. Execute calls `store.updateTask()`, returns `{ taskId, updated: true }` or `{ error }`
- [ ] 4.4 Implement `taskList` tool — Zod schema: `{}` (no params). Execute calls `store.listTasks(listId)`, returns array
- [ ] 4.5 Implement `taskGet` tool — Zod schema: `{ taskId: z.string() }`. Execute calls `store.getTask()`, returns full data or `{ error }`

## 5. Fragment Builders

- [ ] 5.1 Create `packages/context/src/lib/tasks/task-fragments.ts` with `taskFragment(task: TaskSummary | TaskData): ContextFragment` — creates nested `fragment('task', fragment('id', ...), fragment('subject', ...), ...)`, omits empty arrays, omits null owner
- [ ] 5.2 Implement `tasksFragment(tasks: (TaskSummary | TaskData)[]): ContextFragment` — wraps `taskFragment()` results under `fragment('tasks', ...)`

## 6. Barrel Export

- [ ] 6.1 Create `packages/context/src/lib/tasks/index.ts` re-exporting from `task-store.ts`, `sqlite.task-store.ts`, `memory.task-store.ts`, `task-tools.ts`, `task-fragments.ts`
- [ ] 6.2 Add `export * from './lib/tasks/index.ts'` to `packages/context/src/index.ts`

## 7. Integration Tests

- [ ] 7.1 Create `packages/context/test/tasks/task-store.test.ts` using `InMemoryTaskStore`. Test CRUD: create with required fields, create with optional fields, get existing, get non-existent returns undefined, update status, update subject, update non-existent returns undefined, delete existing, delete non-existent returns false
- [ ] 7.2 Test listing: listTasks returns summaries without description/metadata, listTasks scoped by listId, deleted tasks excluded from list, ordered by createdAt ascending
- [ ] 7.3 Test dependencies: create with blockedBy, addBlockedBy via update (no duplicates), addBlocks via update, removeBlockedBy, removeBlocks, listAvailableTasks excludes blocked tasks, listAvailableTasks excludes owned tasks, completing blocker makes dependent available
- [ ] 7.4 Test auto-ID generation: sequential IDs within a list, independent sequences across lists
- [ ] 7.5 Test tools: create `createTaskTools(store, listId)`, verify taskCreate creates and returns id, verify taskUpdate updates status, verify taskList returns summaries, verify taskGet returns full data, verify taskGet with bad id returns error
- [ ] 7.6 Test fragments: `taskFragment` produces correct structure, `tasksFragment` wraps under parent, empty arrays omitted, renders correctly with `render()`

## 8. Build Verification

- [ ] 8.1 Run `nx run context:build` and verify new exports are included in dist
- [ ] 8.2 Run `node --test packages/context/test/tasks/task-store.test.ts` and verify all tests pass
