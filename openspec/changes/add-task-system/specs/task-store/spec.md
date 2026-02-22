## ADDED Requirements

### Requirement: TaskStore abstract class defines the storage contract

The system SHALL provide an abstract `TaskStore` class that defines all task CRUD operations. Concrete implementations (SQLite, in-memory) SHALL extend this class.

#### Scenario: Abstract class cannot be instantiated directly

- **WHEN** a consumer attempts to instantiate `TaskStore` directly
- **THEN** it SHALL fail because `TaskStore` is abstract with unimplemented methods

### Requirement: Task data types

The system SHALL define `TaskData` (full task record) and `TaskSummary` (lightweight listing record) types.

#### Scenario: TaskData contains all fields

- **WHEN** `getTask()` returns a task
- **THEN** it SHALL include: `id` (string), `listId` (string), `subject` (string), `description` (string), `status` (TaskStatus), `owner` (string | null), `activeForm` (string | null), `blockedBy` (string[]), `blocks` (string[]), `metadata` (Record<string, unknown> | null), `createdAt` (number), `updatedAt` (number)

#### Scenario: TaskSummary omits description and metadata

- **WHEN** `listTasks()` returns tasks
- **THEN** each entry SHALL include all `TaskData` fields EXCEPT `description` and `metadata`

### Requirement: Task status lifecycle

The system SHALL enforce the status values: `pending`, `in_progress`, `completed`, `deleted`.

#### Scenario: New tasks start as pending

- **WHEN** `createTask()` is called
- **THEN** the task status SHALL be `pending`

#### Scenario: Status transitions via updateTask

- **WHEN** `updateTask()` is called with a valid status
- **THEN** the task status SHALL be updated and `updatedAt` SHALL be set to current timestamp

### Requirement: createTask persists a new task

`TaskStore.createTask()` SHALL accept task creation data and persist it, returning the full `TaskData`.

#### Scenario: Create with required fields only

- **WHEN** `createTask({ listId: 'session-1', subject: 'Fix bug', description: 'Details here', activeForm: 'Fixing bug' })` is called
- **THEN** it SHALL return a `TaskData` with auto-generated `id`, `status: 'pending'`, `owner: null`, empty `blockedBy` and `blocks`, `metadata: null`, and timestamps

#### Scenario: Create with optional fields

- **WHEN** `createTask()` is called with `owner`, `blockedBy`, `blocks`, and `metadata`
- **THEN** all provided fields SHALL be persisted

### Requirement: getTask returns full task data

`TaskStore.getTask()` SHALL return the complete `TaskData` for a given task ID, or `undefined` if not found.

#### Scenario: Get existing task

- **WHEN** `getTask(taskId)` is called for an existing task
- **THEN** it SHALL return the full `TaskData` including `description` and `metadata`

#### Scenario: Get non-existent task

- **WHEN** `getTask('nonexistent')` is called
- **THEN** it SHALL return `undefined`

### Requirement: updateTask modifies existing tasks

`TaskStore.updateTask()` SHALL accept a task ID and partial update data, applying changes and updating `updatedAt`.

#### Scenario: Update status

- **WHEN** `updateTask(taskId, { status: 'in_progress' })` is called
- **THEN** the task status SHALL change to `in_progress` and `updatedAt` SHALL be refreshed

#### Scenario: Update subject and description

- **WHEN** `updateTask(taskId, { subject: 'New title' })` is called
- **THEN** only the `subject` field SHALL change; other fields SHALL remain unchanged

#### Scenario: Update non-existent task

- **WHEN** `updateTask('nonexistent', { status: 'completed' })` is called
- **THEN** it SHALL return `undefined`

### Requirement: deleteTask removes a task

`TaskStore.deleteTask()` SHALL remove a task by ID and return `true` if it existed, `false` otherwise.

#### Scenario: Delete existing task

- **WHEN** `deleteTask(taskId)` is called for an existing task
- **THEN** it SHALL return `true` and `getTask(taskId)` SHALL return `undefined`

#### Scenario: Delete non-existent task

- **WHEN** `deleteTask('nonexistent')` is called
- **THEN** it SHALL return `false`

### Requirement: listTasks returns scoped summaries

`TaskStore.listTasks()` SHALL return all non-deleted tasks for a given `listId`, sorted by `createdAt` ascending.

#### Scenario: List tasks by listId

- **WHEN** `listTasks('session-1')` is called
- **THEN** it SHALL return only tasks with `listId: 'session-1'`
- **AND** each entry SHALL be a `TaskSummary` (no `description` or `metadata`)

#### Scenario: Deleted tasks excluded

- **WHEN** a task has `status: 'deleted'`
- **THEN** `listTasks()` SHALL NOT include it

### Requirement: SqliteTaskStore implements TaskStore

`SqliteTaskStore` SHALL extend `TaskStore` using `node:sqlite` `DatabaseSync`, prepared statement caching, and DDL from a `.sql` file.

#### Scenario: Constructor accepts path or DatabaseSync

- **WHEN** `new SqliteTaskStore('./tasks.db')` is called
- **THEN** it SHALL create a SQLite database at that path and run DDL

#### Scenario: Constructor accepts existing DatabaseSync

- **WHEN** `new SqliteTaskStore(existingDb)` is called
- **THEN** it SHALL use the provided database and run DDL

### Requirement: InMemoryTaskStore for testing

`InMemoryTaskStore` SHALL extend `SqliteTaskStore` with `':memory:'` for ephemeral in-memory storage.

#### Scenario: InMemoryTaskStore has no constructor args

- **WHEN** `new InMemoryTaskStore()` is called
- **THEN** it SHALL create an in-memory SQLite database ready for use

### Requirement: Auto-generated task IDs

`TaskStore` SHALL auto-generate unique string IDs for new tasks using an auto-incrementing integer counter per `listId`.

#### Scenario: Sequential IDs within a list

- **WHEN** three tasks are created in `listId: 'session-1'`
- **THEN** they SHALL receive IDs `'1'`, `'2'`, `'3'`

#### Scenario: IDs are independent across lists

- **WHEN** tasks are created in different `listId` values
- **THEN** each list SHALL have its own ID sequence
