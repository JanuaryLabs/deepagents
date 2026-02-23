## ADDED Requirements

### Requirement: Engine accepts eval definition

The engine SHALL accept an eval definition containing: dataset (async iterable), task function, scorers array, config object, and a `store` instance. The engine persists all results (runs, cases, scores) to the store during execution.

#### Scenario: Minimal eval execution

- **WHEN** engine receives a dataset of 3 items, a task function, and one scorer
- **THEN** the engine executes the task for each item, scores each output, and returns a run result with 3 scored cases

### Requirement: Task wrapper captures metadata

The engine SHALL wrap the user's task function to automatically capture latency (wall-clock ms), token usage (if returned by the task), and errors.

#### Scenario: Task returns output with usage

- **WHEN** the task function returns `{ output: "...", usage: { inputTokens: 100, outputTokens: 50 } }`
- **THEN** the case result includes latency_ms, tokens_in=100, tokens_out=50

#### Scenario: Task throws an error

- **WHEN** the task function throws an exception
- **THEN** the case result records the error message, scores are 0, and the engine continues with the next case

### Requirement: Concurrency control

The engine SHALL limit parallel case executions to `maxConcurrency` (default: 10). No more than `maxConcurrency` task invocations SHALL be in-flight simultaneously.

#### Scenario: Respecting concurrency limit

- **WHEN** dataset has 100 cases and maxConcurrency is 5
- **THEN** at no point are more than 5 task functions executing concurrently

### Requirement: Per-case timeout

The engine SHALL enforce a `timeout` per case (default: 30000ms). If a task exceeds the timeout, it is aborted and recorded as an error.

#### Scenario: Task exceeds timeout

- **WHEN** a task takes longer than the configured timeout
- **THEN** the case is recorded with an error "timeout exceeded" and score 0, and the engine proceeds to the next case

### Requirement: Trial repetition

The engine SHALL support running each case multiple times via `trials` config (default: 1). When trials > 1, the engine runs the task N times per case and aggregates scores (mean).

#### Scenario: Three trials per case

- **WHEN** trials is 3 and a case scores 0.8, 0.9, 0.7 across trials
- **THEN** the stored score for that case is the mean: 0.8

### Requirement: Event emission

The engine SHALL emit typed events during execution that consumers can subscribe to. `run:start` fires once at the beginning, `run:end` fires once at the end. Per-case events (`case:start`, `case:scored`, `case:error`) fire for each case, but their ordering across cases is non-deterministic when `maxConcurrency > 1`.

#### Scenario: Full event lifecycle

- **WHEN** the engine runs an eval with 2 cases and maxConcurrency=1
- **THEN** it emits in order: `run:start`, `case:start(0)`, `case:scored(0)`, `case:start(1)`, `case:scored(1)`, `run:end`

#### Scenario: Concurrent event interleaving

- **WHEN** the engine runs an eval with 2 cases and maxConcurrency=2
- **THEN** it emits `run:start`, then `case:start(0)` and `case:start(1)` in any order, then `case:scored` events in completion order, then `run:end`

#### Scenario: Error event

- **WHEN** a case throws an error
- **THEN** the engine emits `case:error` with the error details, then ALWAYS emits `case:scored` with score 0 for that case (so consumers can reliably count `case:scored` events as a progress counter)

### Requirement: Engine returns run summary

After all cases are processed, the engine SHALL return a run summary containing: total cases, pass count (score >= threshold), fail count, mean score per scorer, total latency, total tokens.

#### Scenario: Run summary computation

- **WHEN** 100 cases complete with scores [0.8, 0.9, 1.0, ...]
- **THEN** the summary includes count=100, mean score, pass/fail counts at default threshold 0.5, total latency, total tokens
