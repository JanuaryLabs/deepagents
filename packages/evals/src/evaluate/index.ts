import { dataset } from '../dataset/index.ts';
import {
  filterRecordsByIndex,
  parseRecordSelection,
} from '../dataset/record-selection.ts';
import type { TaskFn, TaskResult } from '../engine/index.ts';
import { EvalEmitter, runEval } from '../engine/index.ts';
import type { CaseResult, Reporter } from '../reporters/index.ts';
import type { Scorer } from '../scorers/index.ts';
import type { RunSummary } from '../store/index.ts';
import { RunStore } from '../store/index.ts';

interface BaseEvalOptions<T> {
  /** Human-readable name for this evaluation run, used in reports and filenames. */
  name: string;
  /** The dataset of input/expected pairs to evaluate against. */
  dataset: AsyncIterable<T>;
  /** Named scoring functions that assess model output quality. Each key becomes a column in reports. */
  scorers: Record<string, Scorer>;
  /** Reporters that receive lifecycle events and produce output (console, JSON, CSV, etc.). */
  reporters: Reporter[];
  /** Persistent store for run history. Accepts a `RunStore` instance or a file path for SQLite storage. */
  store: RunStore;
  /** Maximum number of dataset cases to run concurrently. Defaults to unbounded. */
  maxConcurrency?: number;
  /** Per-case timeout in milliseconds before the case is marked as failed. */
  timeout?: number;
  /** Number of times to run each case and average the scores. Useful for reducing LLM variance. */
  trials?: number;
  /** Minimum average score (0–1) required to consider the run passing. Defaults to `0.5`. */
  threshold?: number;
}

export interface EvaluateOptions<T> extends BaseEvalOptions<T> {
  /** The model identifier passed to the task function. */
  model: string;
  /** Function that calls the model under evaluation and returns its output for a single dataset item. */
  task: TaskFn<T>;
  /** Associates this run with an existing suite ID for grouped comparisons. */
  suiteId?: string;
}

export interface EvaluateEachOptions<
  T,
  V extends { name: string },
> extends BaseEvalOptions<T> {
  /** List of model variants to evaluate. Each variant runs the full dataset independently. */
  models: V[];
  /** Function that calls the model under evaluation for a given dataset item and model variant. */
  task: (input: T, variant: V) => Promise<TaskResult>;
}

type Selection =
  | { type: 'all' }
  | { type: 'failed' }
  | { type: 'cases'; indexes: Set<number> }
  | { type: 'sample'; count: number };

export class EvalAssertionError extends Error {
  summary: RunSummary | RunSummary[];

  constructor(summary: RunSummary | RunSummary[]) {
    const msg = Array.isArray(summary)
      ? `Eval assertion failed: ${summary.filter((s) => s.failCount > 0).length} of ${summary.length} model runs have failures`
      : `Eval assertion failed: ${summary.failCount} of ${summary.totalCases} cases failed`;
    super(msg);
    this.name = 'EvalAssertionError';
    this.summary = summary;
  }
}

function resolveFailedIndexes(
  store: RunStore,
  suiteName: string,
  model?: string,
  threshold?: number,
): Set<number> {
  const suite = store.findSuiteByName(suiteName);
  if (!suite) {
    console.warn(
      `No previous suite found for '${suiteName}'. Running all cases.`,
    );
    return new Set();
  }
  const run = store.getLatestCompletedRun(suite.id, model);
  if (!run) {
    console.warn(
      `No previous completed run found for '${suiteName}'${model ? ` [${model}]` : ''}. Running all cases.`,
    );
    return new Set();
  }
  const failingCases = store.getFailingCases(run.id, threshold);
  if (failingCases.length === 0) {
    console.warn(`No failed cases in previous run. Running all cases.`);
    return new Set();
  }
  console.warn(
    `Retrying ${failingCases.length} failed cases from previous run`,
  );
  return new Set(failingCases.map((c) => c.idx));
}

export class EvalBuilder<R> implements PromiseLike<R> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #options: EvaluateOptions<any> | EvaluateEachOptions<any, any>;
  #selection: Selection = { type: 'all' };
  #shouldAssert = false;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: EvaluateOptions<any> | EvaluateEachOptions<any, any>,
  ) {
    this.#options = options;
  }

  #setSelection(selection: Selection): this {
    if (this.#selection.type !== 'all') {
      throw new Error(
        `Cannot combine .${this.#selection.type}() with .${selection.type}()`,
      );
    }
    this.#selection = selection;
    return this;
  }

  failed(): this {
    return this.#setSelection({ type: 'failed' });
  }

  cases(spec: string): this {
    const { indexes } = parseRecordSelection(spec);
    return this.#setSelection({ type: 'cases', indexes });
  }

  sample(count: number): this {
    if (count < 1) {
      throw new Error('Sample count must be >= 1');
    }
    return this.#setSelection({ type: 'sample', count });
  }

  assert(): this {
    this.#shouldAssert = true;
    return this;
  }

  then<TResult1 = R, TResult2 = never>(
    onfulfilled?:
      | ((value: R) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): Promise<TResult1 | TResult2> {
    return this.#execute().then(onfulfilled, onrejected);
  }

  async #execute(): Promise<R> {
    if ('models' in this.#options) {
      return this.#executeMulti() as Promise<R>;
    }
    return this.#executeSingle() as Promise<R>;
  }

  #applyDatasetFilter(ds: AsyncIterable<unknown>): AsyncIterable<unknown> {
    switch (this.#selection.type) {
      case 'all':
        return ds;
      case 'cases':
        return this.#selection.indexes.size > 0
          ? filterRecordsByIndex(ds, this.#selection.indexes)
          : ds;
      case 'sample':
        return dataset(ds).sample(this.#selection.count);
      case 'failed':
        return ds;
    }
  }

  async #executeSingle(): Promise<RunSummary> {
    const options = this.#options as EvaluateOptions<unknown>;
    let ds: AsyncIterable<unknown> = options.dataset;

    if (this.#selection.type === 'failed') {
      const indexes = resolveFailedIndexes(
        options.store,
        options.name,
        options.model,
        options.threshold,
      );
      if (indexes.size > 0) {
        ds = filterRecordsByIndex(ds, indexes);
      }
    } else {
      ds = this.#applyDatasetFilter(ds);
    }

    const result = await evaluateSingle({ ...options, dataset: ds });

    if (this.#shouldAssert && result.failCount > 0) {
      throw new EvalAssertionError(result);
    }

    return result;
  }

  async #executeMulti(): Promise<RunSummary[]> {
    const options = this.#options as EvaluateEachOptions<
      unknown,
      { name: string }
    >;

    let result: RunSummary[];

    if (this.#selection.type === 'failed') {
      const perModelIndexes = new Map<string, Set<number>>();
      for (const variant of options.models) {
        perModelIndexes.set(
          variant.name,
          resolveFailedIndexes(
            options.store,
            options.name,
            variant.name,
            options.threshold,
          ),
        );
      }
      result = await evaluateEach(options, perModelIndexes);
    } else {
      const filtered = this.#applyDatasetFilter(options.dataset);
      result = await evaluateEach({ ...options, dataset: filtered });
    }

    if (this.#shouldAssert && result.some((s) => s.failCount > 0)) {
      throw new EvalAssertionError(result);
    }

    return result;
  }
}

export function evaluate<T>(
  options: EvaluateOptions<T>,
): EvalBuilder<RunSummary>;
export function evaluate<T, V extends { name: string }>(
  options: EvaluateEachOptions<T, V>,
): EvalBuilder<RunSummary[]>;
export function evaluate<T, V extends { name: string }>(
  options: EvaluateOptions<T> | EvaluateEachOptions<T, V>,
): EvalBuilder<RunSummary> | EvalBuilder<RunSummary[]> {
  if ('models' in options) {
    return new EvalBuilder<RunSummary[]>(options);
  }
  return new EvalBuilder<RunSummary>(options);
}

function wireReporters(reporters: Reporter[]) {
  const emitter = new EvalEmitter();
  const cases: CaseResult[] = [];
  let runId = '';

  emitter.on('run:start', (data) => {
    runId = data.runId;
    for (const r of reporters) r.onRunStart?.(data);
  });

  emitter.on('case:scored', (data) => {
    const result: CaseResult = {
      runId: data.runId,
      index: data.index,
      input: data.input,
      output: data.output,
      expected: data.expected,
      scores: data.scores,
      error: data.error ?? null,
      latencyMs: data.latencyMs,
      tokensIn: data.tokensIn,
      tokensOut: data.tokensOut,
    };
    cases.push(result);
    for (const r of reporters) r.onCaseEnd?.(result);
  });

  return { emitter, cases, getRunId: () => runId };
}

async function notifyRunEnd(
  reporters: Reporter[],
  data: {
    runId: string;
    name: string;
    model: string;
    summary: RunSummary;
    cases: CaseResult[];
    threshold: number;
  },
): Promise<void> {
  data.cases.sort((a, b) => a.index - b.index);
  await Promise.all(reporters.map((r) => r.onRunEnd?.(data)));
}

async function evaluateSingle<T>(
  options: EvaluateOptions<T>,
): Promise<RunSummary> {
  const threshold = options.threshold ?? 0.5;
  const { emitter, cases, getRunId } = wireReporters(options.reporters);

  const summary = await runEval({
    name: options.name,
    model: options.model,
    dataset: options.dataset,
    task: options.task,
    scorers: options.scorers,
    store: options.store,
    emitter,
    suiteId: options.suiteId,
    maxConcurrency: options.maxConcurrency,
    timeout: options.timeout,
    trials: options.trials,
    threshold: options.threshold,
  });

  await notifyRunEnd(options.reporters, {
    runId: getRunId(),
    name: options.name,
    model: options.model,
    summary,
    cases,
    threshold,
  });

  return summary;
}

async function evaluateEach<T, V extends { name: string }>(
  options: EvaluateEachOptions<T, V>,
  perModelFailedIndexes?: Map<string, Set<number>>,
): Promise<RunSummary[]> {
  const items: T[] = [];
  for await (const item of options.dataset) {
    items.push(item);
  }

  const suite = options.store.createSuite(options.name);

  return Promise.all(
    options.models.map((variant) => {
      let ds: AsyncIterable<T> = dataset(items);
      const failedIndexes = perModelFailedIndexes?.get(variant.name);
      if (failedIndexes && failedIndexes.size > 0) {
        ds = filterRecordsByIndex(ds, failedIndexes);
      }
      return evaluateSingle({
        name: `${options.name} [${variant.name}]`,
        model: variant.name,
        dataset: ds,
        task: (input: T) => options.task(input, variant),
        scorers: options.scorers,
        reporters: options.reporters,
        store: options.store,
        suiteId: suite.id,
        maxConcurrency: options.maxConcurrency,
        timeout: options.timeout,
        trials: options.trials,
        threshold: options.threshold,
      });
    }),
  );
}
