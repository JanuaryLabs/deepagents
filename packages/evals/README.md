# @deepagents/evals

A general-purpose LLM evaluation framework with dataset loading, scoring, run persistence, model comparison, and console reporting.

## Installation

```bash
npm install @deepagents/evals
```

## Quick Start

```typescript
import { dataset, evaluate, exactMatch } from '@deepagents/evals';

const summary = await evaluate({
  name: 'my-eval',
  model: 'gpt-4o',
  dataset: dataset([
    { input: 'What is 2+2?', expected: '4' },
    { input: 'What is 3+3?', expected: '6' },
  ]),
  task: async (item) => {
    const response = await callMyLLM(item.input);
    return { output: response };
  },
  scorers: { exact: exactMatch },
});
```

## Modules

The package is organized into subpath exports for granular imports:

| Import                         | Description                             |
| ------------------------------ | --------------------------------------- |
| `@deepagents/evals`            | Top-level convenience API (`evaluate`)  |
| `@deepagents/evals/dataset`    | Dataset loading and transforms          |
| `@deepagents/evals/scorers`    | Scorer functions and combinators        |
| `@deepagents/evals/store`      | SQLite run persistence                  |
| `@deepagents/evals/engine`     | Eval engine with concurrency and events |
| `@deepagents/evals/comparison` | Run diffing and regression detection    |
| `@deepagents/evals/reporters`  | Console reporter                        |

## Dataset

Load data from inline arrays or local files (JSON, JSONL, CSV):

```typescript
import { dataset } from '@deepagents/evals/dataset';

// Inline array
const ds = dataset([{ input: 'hello', expected: 'world' }]);

// From file
const ds = dataset('./data/questions.json');
const ds = dataset('./data/questions.jsonl');
const ds = dataset('./data/questions.csv');
```

### Transforms

Chainable, lazy transforms on datasets:

```typescript
dataset('./large-dataset.jsonl')
  .filter((row) => row.difficulty === 'hard')
  .map((row) => ({ input: row.question, expected: row.answer }))
  .shuffle()
  .limit(100);
```

| Transform    | Behavior                                     |
| ------------ | -------------------------------------------- |
| `map(fn)`    | Lazy — transforms each element               |
| `filter(fn)` | Lazy — excludes non-matching elements        |
| `limit(n)`   | Lazy — caps output at n elements             |
| `shuffle()`  | Eager — buffers all, randomizes order        |
| `sample(n)`  | Eager — buffers all, picks n random elements |
| `toArray()`  | Consumes into a plain array                  |

## Scorers

All scorers return `{ score: number (0..1), reason?: string }`.

### Deterministic Scorers

```typescript
import {
  exactMatch,
  includes,
  jsonMatch,
  levenshtein,
  regex,
} from '@deepagents/evals/scorers';
```

| Scorer           | Description                         |
| ---------------- | ----------------------------------- |
| `exactMatch`     | Strict string equality              |
| `includes`       | Substring check                     |
| `regex(pattern)` | RegExp test                         |
| `levenshtein`    | Normalized edit distance similarity |
| `jsonMatch`      | Deep JSON structural equality       |

### LLM-Based Scorers

```typescript
import { factuality, llmJudge } from '@deepagents/evals/scorers';

const judge = llmJudge({ model: myModel, criteria: 'Is the answer helpful?' });
const fact = factuality({ model: myModel });
```

### Combinators

```typescript
import { all, any, weighted } from '@deepagents/evals/scorers';

// Weakest-link (minimum score)
const strict = all(exactMatch, includes);

// Best-of (maximum score)
const lenient = any(exactMatch, includes);

// Weighted average
const balanced = weighted({
  accuracy: { scorer: exactMatch, weight: 2 },
  style: { scorer: llmJudge({ model, criteria: '...' }), weight: 1 },
});
```

## Run Store

SQLite-backed persistence for runs, cases, and scores:

```typescript
import { RunStore } from '@deepagents/evals/store';

const store = new RunStore('.evals/store.db');

// Create a suite for grouping runs
const suite = store.createSuite('text2sql-accuracy');

// Query results
const runs = store.listRuns(suite.id);
const failing = store.getFailingCases(runId, 0.5);
const summary = store.getRunSummary(runId);
```

## Engine

The engine orchestrates dataset iteration, task execution, scoring, and persistence:

```typescript
import { EvalEmitter, runEval } from '@deepagents/evals/engine';

const emitter = new EvalEmitter();
emitter.on('case:scored', (data) => console.log(data.index, data.scores));

const summary = await runEval({
  name: 'my-eval',
  model: 'gpt-4o',
  dataset: ds,
  task: myTask,
  scorers: { exact: exactMatch },
  store,
  emitter,
  maxConcurrency: 10,
  timeout: 30_000,
  trials: 1,
  threshold: 0.5,
});
```

### Events

| Event         | Payload                               | When                                      |
| ------------- | ------------------------------------- | ----------------------------------------- |
| `run:start`   | `{ runId, totalCases, name, model }`  | Run begins                                |
| `case:start`  | `{ runId, index, input }`             | Case execution starts                     |
| `case:scored` | `{ runId, index, scores, latencyMs }` | Case scored (always fires, even on error) |
| `case:error`  | `{ runId, index, error }`             | Task threw an error                       |
| `run:end`     | `{ runId, summary }`                  | All cases complete                        |

## Comparison

Compare two runs case-by-case to detect improvements and regressions:

```typescript
import { compareRuns } from '@deepagents/evals/comparison';

const result = compareRuns(store, baselineRunId, candidateRunId, {
  tolerance: 0.01,
  regressionThreshold: 0.05,
});

console.log(result.regression.regressed); // true if any scorer regressed
console.log(result.scorerSummaries); // per-scorer mean deltas and counts
console.log(result.costDelta); // latency and token differences
```

## Console Reporter

Subscribe to engine events for terminal output:

```typescript
import { consoleReporter } from '@deepagents/evals/reporters';

consoleReporter(emitter, {
  verbosity: 'normal', // 'quiet' | 'normal' | 'verbose'
  threshold: 0.5,
});
```

## License

MIT
