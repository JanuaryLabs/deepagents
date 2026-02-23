## Context

The deepagents monorepo currently uses evalite (third-party) for text2sql evals. It lacks run persistence, model comparison, and is tightly coupled to one package. The `packages/evals` directory exists as an empty scaffold with `src/lib/engine/`, `src/lib/reporters/`, `src/lib/runners/console/`, `src/lib/runners/web/`. A web runner already exists and will import the engine directly as a library.

The framework targets research/exploration workflows: rapid prompt iteration, multi-model comparison, and persistent result tracking. It is general-purpose — not tied to text2sql.

## Goals / Non-Goals

**Goals:**

- General-purpose LLM evaluation framework usable by any package
- Dataset-driven: load from local files or inline arrays
- Persistent run storage in SQLite with suite-linked runs for model comparison
- Event-driven engine consumable by both console reporter and existing web runner
- Subpath exports (`/engine`, `/scorers`, `/store`, `/reporters`, `/comparison`, `/dataset`) for granular imports
- Ship useful built-in scorers (deterministic + LLM-as-judge)

**Non-Goals:**

- HuggingFace auto-download (user provides data locally)
- HTML report generation
- Statistical significance testing
- Annotation/manual labeling system
- Dataset versioning or dataset hosting
- Web runner implementation (already exists)

## Decisions

### 1. SQLite schema: suite-linked runs (Option C)

Each model execution is a separate `run` row. Runs are grouped by `suite_id` for comparison. This was chosen over matrix runs (all variants in one run) because:

- Clean lifecycle: each run is atomic (succeeded or failed for one model)
- Easy to add models later (new run, same suite_id)
- Re-runs don't require mutating existing data
- Deleting a variant's results = deleting a run

**Schema:**

```
suites (id, name, created_at)
runs (id, suite_id, name, model, config, started_at, finished_at, status, summary)
cases (id, run_id, index, input, output, expected, latency_ms, tokens_in, tokens_out, error)
scores (id, case_id, scorer_name, score, reason)
```

**Alternatives considered:**

- Matrix run (Option B): simpler queries but awkward partial failures, re-runs, and adding models after the fact.
- Flat JSON files: simple and git-trackable but impossible to query across runs efficiently.

### 2. Event-driven engine

The engine emits events (`case:start`, `case:scored`, `case:error`, `run:start`, `run:end`) via a typed EventEmitter. The web runner and console reporter both subscribe to these events. Neither consumer is "special" — adding a third (CI reporter, Slack notifier) requires no engine changes.

The engine requires a `store` parameter and always persists results. This ensures every run is recorded — no silent data loss from forgetting to wire persistence.

**Alternatives considered:**

- Optional store: more flexible but introduces "sometimes it saves, sometimes it doesn't" ambiguity. Research workflows need persistence by default.
- Callback-based: simpler but only supports one consumer per event.
- Stream-based: overkill for progress reporting; streams are better for data pipelines.

### 3. Scorer interface: `{ score, reason }`

All scorers return `{ score: number, reason?: string }` where score is normalized to `0..1`. This uniform interface enables composition (`all`, `any`, `weighted`) and consistent storage.

LLM-based scorers accept a `model` parameter — the user decides which model judges their outputs. No hardcoded judge model.

**Alternatives considered:**

- Boolean pass/fail: too coarse for research. A 0..1 scale shows gradations.
- Structured rubric scores (multiple dimensions per scorer): over-complex for v1. Users can compose multiple single-dimension scorers instead.

### 4. Dataset as async iterable

Datasets are async iterables so large files don't need to fit in memory. Transforms (map, filter, limit) are lazy and chainable. `shuffle` and `sample` are eager exceptions — they buffer the full dataset into memory to randomize, then yield results. The `dataset()` helper accepts `Array | string (file path)` and returns an async iterable.

**Alternatives considered:**

- Eager array loading: simpler but 10k+ row datasets would consume too much memory for all transforms.
- Node.js ReadableStream: more powerful but harder to compose transforms on.

### 5. Concurrency via semaphore pattern

The engine uses a concurrency limiter (semaphore) to control parallel case execution. Configurable via `maxConcurrency` in the engine config. This avoids blowing API rate limits when running thousands of cases.

Trials (running each case N times) multiply the work: 10k cases × 3 trials = 30k executions. The semaphore ensures only `maxConcurrency` are in-flight at once.

### 6. Subpath exports for modularity

The package uses Node.js subpath exports in package.json:

- `@deepagents/evals` — top-level convenience API
- `@deepagents/evals/engine` — engine internals
- `@deepagents/evals/scorers` — scorer functions
- `@deepagents/evals/store` — SQLite run store
- `@deepagents/evals/dataset` — dataset loading and transforms
- `@deepagents/evals/comparison` — run diffing
- `@deepagents/evals/reporters` — console reporter

This lets the web runner import only what it needs without pulling in console-specific code.

## Risks / Trade-offs

- **[LLM-as-judge cost]** → Scoring 10k cases with an LLM judge doubles the API calls. Mitigation: make LLM scorers opt-in, ship cheap deterministic scorers as defaults.
- **[SQLite contention]** → Concurrent writes from parallel case scoring. Mitigation: WAL mode, batch inserts after each case completes (not during scoring).
- **[Breaking text2sql evals]** → Removing evalite means all existing evals must be rewritten. Mitigation: same datasets are reusable, only the runner/scorer API changes.
- **[Async iterable complexity]** → Harder to debug than arrays. Mitigation: datasets can also be plain arrays — async iterable is the internal protocol, not a requirement on users.
