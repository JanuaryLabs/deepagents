import { dataset } from '../dataset/index.ts';
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
  store?: RunStore | string;
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

export function evaluate<T>(options: EvaluateOptions<T>): Promise<RunSummary>;
export function evaluate<T, V extends { name: string }>(
  options: EvaluateEachOptions<T, V>,
): Promise<RunSummary[]>;
export async function evaluate<T, V extends { name: string }>(
  options: EvaluateOptions<T> | EvaluateEachOptions<T, V>,
): Promise<RunSummary | RunSummary[]> {
  if ('models' in options) {
    return evaluateEach(options as EvaluateEachOptions<T, V>);
  }
  return evaluateSingle(options as EvaluateOptions<T>);
}

function resolveStore(store?: RunStore | string): RunStore {
  return store instanceof RunStore ? store : new RunStore(store);
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
  const store = resolveStore(options.store);
  const threshold = options.threshold ?? 0.5;
  const { emitter, cases, getRunId } = wireReporters(options.reporters);

  const summary = await runEval({
    name: options.name,
    model: options.model,
    dataset: options.dataset,
    task: options.task,
    scorers: options.scorers,
    store,
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
): Promise<RunSummary[]> {
  const store = resolveStore(options.store);

  const items: T[] = [];
  for await (const item of options.dataset) {
    items.push(item);
  }

  const suite = store.createSuite(options.name);

  return Promise.all(
    options.models.map((variant) =>
      evaluateSingle({
        name: `${options.name} [${variant.name}]`,
        model: variant.name,
        dataset: dataset(items),
        task: (input: T) => options.task(input, variant),
        scorers: options.scorers,
        reporters: options.reporters,
        store,
        suiteId: suite.id,
        maxConcurrency: options.maxConcurrency,
        timeout: options.timeout,
        trials: options.trials,
        threshold: options.threshold,
      }),
    ),
  );
}
