## ADDED Requirements

### Requirement: taskFragment converts a single task to ContextFragment

The system SHALL provide `taskFragment(task: TaskSummary | TaskData): ContextFragment` that converts a task record into a nested `ContextFragment` suitable for rendering.

#### Scenario: Task with all fields produces nested fragment

- **WHEN** `taskFragment({ id: '1', subject: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug', blockedBy: [], blocks: ['2'] })` is called
- **THEN** it SHALL return `fragment('task', fragment('id', '1'), fragment('subject', 'Fix bug'), fragment('status', 'in_progress'), fragment('activeForm', 'Fixing bug'), fragment('blocks', '2'))`

#### Scenario: Empty arrays omitted from fragment

- **WHEN** a task has `blockedBy: []` and `blocks: []`
- **THEN** the resulting fragment SHALL NOT include `blockedBy` or `blocks` children

#### Scenario: Owner included when present

- **WHEN** a task has `owner: 'agent-1'`
- **THEN** the resulting fragment SHALL include `fragment('owner', 'agent-1')`

### Requirement: tasksFragment wraps multiple tasks under a parent

The system SHALL provide `tasksFragment(tasks: (TaskSummary | TaskData)[]): ContextFragment` that wraps all task fragments under a `'tasks'` parent fragment.

#### Scenario: Multiple tasks produce parent fragment

- **WHEN** `tasksFragment([task1, task2, task3])` is called
- **THEN** it SHALL return `fragment('tasks', taskFragment(task1), taskFragment(task2), taskFragment(task3))`

#### Scenario: Empty array produces empty parent

- **WHEN** `tasksFragment([])` is called
- **THEN** it SHALL return `fragment('tasks')` with no children

### Requirement: Fragments render correctly with existing renderers

Task fragments SHALL be compatible with `XmlRenderer`, `MarkdownRenderer`, and `ToonRenderer` via the existing `render()` function.

#### Scenario: XML rendering

- **WHEN** `render('active_tasks', tasksFragment(tasks))` is called with `XmlRenderer`
- **THEN** it SHALL produce valid XML with `<active_tasks><tasks><task><id>...</id><subject>...</subject>...</task></tasks></active_tasks>`

#### Scenario: Markdown rendering

- **WHEN** the same fragment is rendered with `MarkdownRenderer`
- **THEN** it SHALL produce Markdown with headings and key-value pairs

### Requirement: Fragment builders are pure functions

`taskFragment` and `tasksFragment` SHALL be pure functions with no side effects. They SHALL NOT access or depend on any store instance.

#### Scenario: No store dependency

- **WHEN** `taskFragment(taskData)` is called
- **THEN** it SHALL use only the provided task data object — no database calls, no external state
