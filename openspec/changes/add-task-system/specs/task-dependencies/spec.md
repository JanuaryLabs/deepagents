## ADDED Requirements

### Requirement: Tasks support blockedBy and blocks fields

Each task SHALL have `blockedBy: string[]` and `blocks: string[]` fields that form a directed acyclic graph of dependencies.

#### Scenario: Set blockedBy on creation

- **WHEN** `createTask({ ..., blockedBy: ['1', '2'] })` is called
- **THEN** the created task SHALL have `blockedBy: ['1', '2']`

#### Scenario: Set blocks on creation

- **WHEN** `createTask({ ..., blocks: ['3'] })` is called
- **THEN** the created task SHALL have `blocks: ['3']`

### Requirement: Add dependencies via updateTask

`updateTask()` SHALL support `addBlockedBy` and `addBlocks` fields that append to existing dependency arrays without duplicates.

#### Scenario: Add blockedBy via update

- **WHEN** a task has `blockedBy: ['1']` and `updateTask(id, { addBlockedBy: ['2', '3'] })` is called
- **THEN** the task SHALL have `blockedBy: ['1', '2', '3']`

#### Scenario: Add blocks via update

- **WHEN** a task has `blocks: []` and `updateTask(id, { addBlocks: ['5'] })` is called
- **THEN** the task SHALL have `blocks: ['5']`

#### Scenario: Duplicate dependencies are not added

- **WHEN** a task has `blockedBy: ['1']` and `updateTask(id, { addBlockedBy: ['1', '2'] })` is called
- **THEN** the task SHALL have `blockedBy: ['1', '2']` (no duplicate `'1'`)

### Requirement: Remove dependencies via updateTask

`updateTask()` SHALL support `removeBlockedBy` and `removeBlocks` fields that remove specific entries from dependency arrays.

#### Scenario: Remove blockedBy entry

- **WHEN** a task has `blockedBy: ['1', '2', '3']` and `updateTask(id, { removeBlockedBy: ['2'] })` is called
- **THEN** the task SHALL have `blockedBy: ['1', '3']`

#### Scenario: Remove non-existent dependency is a no-op

- **WHEN** `updateTask(id, { removeBlockedBy: ['999'] })` is called and `'999'` is not in `blockedBy`
- **THEN** the `blockedBy` array SHALL remain unchanged

### Requirement: listAvailableTasks returns only unblocked work

`TaskStore.listAvailableTasks(listId)` SHALL return tasks that meet ALL three conditions: `status === 'pending'`, `owner === null`, and all tasks in `blockedBy` have `status === 'completed'`.

#### Scenario: Task with no dependencies is available

- **WHEN** a task has `status: 'pending'`, `owner: null`, and `blockedBy: []`
- **THEN** `listAvailableTasks()` SHALL include it

#### Scenario: Task blocked by incomplete dependency is not available

- **WHEN** task A has `blockedBy: ['B']` and task B has `status: 'in_progress'`
- **THEN** `listAvailableTasks()` SHALL NOT include task A

#### Scenario: Task becomes available when blockers complete

- **WHEN** task A has `blockedBy: ['B']` and task B is updated to `status: 'completed'`
- **THEN** `listAvailableTasks()` SHALL include task A

#### Scenario: Owned task is not available

- **WHEN** a task has `status: 'pending'` and `owner: 'agent-1'`
- **THEN** `listAvailableTasks()` SHALL NOT include it

#### Scenario: Completed task is not available

- **WHEN** a task has `status: 'completed'`
- **THEN** `listAvailableTasks()` SHALL NOT include it

### Requirement: Dependency status reflected in listTasks

`listTasks()` SHALL include the `blockedBy` field in `TaskSummary` so consumers can see which tasks are blocked and by whom.

#### Scenario: blockedBy visible in task list

- **WHEN** `listTasks()` is called
- **THEN** each `TaskSummary` SHALL include `blockedBy` and `blocks` arrays
