## 1. Package Scaffolding

- [x] 1.1 Update existing `packages/evals` package.json with subpath exports (`/engine`, `/scorers`, `/store`, `/dataset`, `/comparison`, `/reporters`)
- [x] 1.2 Update project.json build target and TypeScript config
- [x] 1.3 Replace existing `src/lib/` scaffold with new structure: `src/engine/`, `src/scorers/`, `src/store/`, `src/dataset/`, `src/comparison/`, `src/reporters/`

## 2. Dataset

- [x] 2.1 Implement dataset loader: accept inline array or file path (JSON, JSONL, CSV), return async iterable
- [x] 2.2 Implement transforms: `map`, `filter`, `limit`, `shuffle`, `sample` as chainable operations on async iterables
- [x] 2.3 Write integration tests for dataset loading and transforms

## 3. Scorers

- [x] 3.1 Define scorer type interface: `(args: { input, output, expected? }) => Promise<{ score, reason? }>`
- [x] 3.2 Implement deterministic scorers: `exactMatch`, `includes`, `regex`, `levenshtein`, `jsonMatch`
- [x] 3.3 Implement LLM-based scorers: `llmJudge({ model, criteria })`, `factuality({ model })`, `sqlMatch({ model })`
- [x] 3.4 Implement composition combinators: `all()`, `any()`, `weighted()`
- [x] 3.5 Write integration tests for deterministic scorers and composition

## 4. Run Store (SQLite)

- [x] 4.1 Define SQLite schema: `suites`, `runs`, `cases`, `scores` tables with WAL mode
- [x] 4.2 Implement store initialization (create tables, enable WAL)
- [x] 4.3 Implement write methods: `createSuite`, `createRun`, `saveCases`, `saveScores`
- [x] 4.4 Implement read methods: `getRun`, `listRuns`, `getCases`, `getFailingCases`, `getRunSummary`, `listSuites`
- [x] 4.5 Write integration tests for store CRUD and query operations

## 5. Engine

- [x] 5.1 Implement typed event emitter with events: `run:start`, `case:start`, `case:scored`, `case:error`, `run:end`
- [x] 5.2 Implement task wrapper: capture latency, token usage, errors, enforce timeout
- [x] 5.3 Implement concurrency limiter (semaphore pattern) with configurable `maxConcurrency`
- [x] 5.4 Implement trial repetition: run each case N times, aggregate scores via mean
- [x] 5.5 Implement main engine loop: iterate dataset, run task+scorers with concurrency, emit events, persist to store
- [x] 5.6 Implement run summary computation: total cases, mean score per scorer, pass/fail counts, total latency/tokens
- [x] 5.7 Write integration tests for engine execution, concurrency, trials, and event emission

## 6. Comparison

- [x] 6.1 Implement case-by-case diff: match cases by dataset index, compute per-case score deltas
- [x] 6.2 Implement change categorization: improved/regressed/unchanged with configurable tolerance
- [x] 6.3 Implement aggregate deltas: mean score change per scorer, improved/regressed/unchanged counts
- [x] 6.4 Implement cost/token delta computation
- [x] 6.5 Implement regression detection: flag when mean score drops beyond threshold
- [x] 6.6 Write integration tests for comparison and regression detection

## 7. Console Reporter

- [x] 7.1 Implement event subscription and progress display (completed/total counter)
- [x] 7.2 Implement summary table rendering on `run:end` (name, model, scores, pass/fail, duration, tokens)
- [x] 7.3 Implement failing case detail output with truncated input/output/expected
- [x] 7.4 Implement verbosity levels: `quiet`, `normal`, `verbose`

## 8. Top-Level API

- [x] 8.1 Implement convenience entry point function that wires dataset + task + scorers → engine → store
- [x] 8.2 Wire all subpath exports in package.json and verify they resolve correctly
- [x] 8.3 Remove evalite and autoevals dependencies from text2sql package
