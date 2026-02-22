## ADDED Requirements

### Requirement: createTaskTools factory function

The system SHALL provide `createTaskTools(store: TaskStore, listId: string)` that returns a `ToolSet` containing `taskCreate`, `taskUpdate`, `taskList`, and `taskGet` tools compatible with the Vercel AI SDK.

#### Scenario: Factory returns all four tools

- **WHEN** `createTaskTools(store, 'session-1')` is called
- **THEN** it SHALL return an object with keys `taskCreate`, `taskUpdate`, `taskList`, `taskGet`
- **AND** each value SHALL be a valid AI SDK `tool()` definition

### Requirement: taskCreate tool

The `taskCreate` tool SHALL create a new task via `TaskStore.createTask()`.

#### Scenario: Create task with required parameters

- **WHEN** the LLM calls `taskCreate` with `{ subject: 'Fix auth', description: 'Details', activeForm: 'Fixing auth' }`
- **THEN** the tool SHALL call `store.createTask()` with the provided fields and the factory's `listId`
- **AND** return `{ id, subject }` as confirmation

#### Scenario: Create task with optional parameters

- **WHEN** the LLM calls `taskCreate` with `blockedBy` and `metadata`
- **THEN** those fields SHALL be passed through to `store.createTask()`

### Requirement: taskUpdate tool

The `taskUpdate` tool SHALL update an existing task via `TaskStore.updateTask()`.

#### Scenario: Update task status

- **WHEN** the LLM calls `taskUpdate` with `{ taskId: '1', status: 'in_progress' }`
- **THEN** the tool SHALL call `store.updateTask('1', { status: 'in_progress' })`
- **AND** return `{ taskId, updated: true }`

#### Scenario: Add dependencies via tool

- **WHEN** the LLM calls `taskUpdate` with `{ taskId: '2', addBlockedBy: ['1'] }`
- **THEN** the tool SHALL pass `addBlockedBy` to `store.updateTask()`

#### Scenario: Update non-existent task

- **WHEN** the LLM calls `taskUpdate` with a non-existent `taskId`
- **THEN** the tool SHALL return `{ error: 'Task not found' }`

### Requirement: taskList tool

The `taskList` tool SHALL return all tasks for the factory's `listId` via `TaskStore.listTasks()`.

#### Scenario: List returns compact summaries

- **WHEN** the LLM calls `taskList` with no parameters
- **THEN** the tool SHALL return an array of `TaskSummary` objects (no `description`, no `metadata`)

### Requirement: taskGet tool

The `taskGet` tool SHALL return full task details via `TaskStore.getTask()`.

#### Scenario: Get existing task

- **WHEN** the LLM calls `taskGet` with `{ taskId: '1' }`
- **THEN** the tool SHALL return the full `TaskData` including `description` and `metadata`

#### Scenario: Get non-existent task

- **WHEN** the LLM calls `taskGet` with a non-existent `taskId`
- **THEN** the tool SHALL return `{ error: 'Task not found' }`

### Requirement: Tool parameter schemas use Zod

All tool parameter schemas SHALL be defined with Zod and include `.describe()` annotations for LLM guidance.

#### Scenario: taskCreate schema

- **WHEN** the `taskCreate` tool schema is inspected
- **THEN** `subject` SHALL be `z.string().describe('Brief imperative title')`
- **AND** `description` SHALL be `z.string().describe('Detailed requirements')`
- **AND** `activeForm` SHALL be `z.string().describe('Present-continuous spinner text')`

#### Scenario: taskUpdate schema

- **WHEN** the `taskUpdate` tool schema is inspected
- **THEN** `taskId` SHALL be required
- **AND** `status`, `subject`, `description`, `owner`, `addBlockedBy`, `addBlocks`, `removeBlockedBy`, `removeBlocks` SHALL be optional
