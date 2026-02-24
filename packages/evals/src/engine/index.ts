import { EventEmitter } from 'node:events';

import type { Scorer, ScorerResult } from '../scorers/index.ts';
import type {
  CaseData,
  RunStore,
  RunSummary,
  ScoreData,
} from '../store/index.ts';

export interface TaskResult {
  output: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type TaskFn<T> = (input: T) => Promise<TaskResult>;

export interface EngineEvents {
  'run:start': {
    runId: string;
    totalCases: number;
    name: string;
    model: string;
  };
  'case:start': { runId: string; index: number; input: unknown };
  'case:scored': {
    runId: string;
    index: number;
    input: unknown;
    output: string;
    expected: unknown;
    scores: Record<string, ScorerResult>;
    error?: unknown;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
  };
  'case:error': { runId: string; index: number; error: string };
  'run:end': { runId: string; summary: RunSummary };
}

export class EvalEmitter extends EventEmitter {
  override on<K extends keyof EngineEvents>(
    event: K,
    listener: (data: EngineEvents[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof EngineEvents>(
    event: K,
    data: EngineEvents[K],
  ): boolean {
    return super.emit(event, data);
  }
}

export interface EvalConfig<T> {
  name: string;
  model: string;
  dataset: AsyncIterable<T>;
  task: TaskFn<T>;
  scorers: Record<string, Scorer>;
  store: RunStore;
  emitter?: EvalEmitter;
  suiteId?: string;
  config?: Record<string, unknown>;
  maxConcurrency?: number;
  batchSize?: number;
  timeout?: number;
  trials?: number;
  threshold?: number;
}

interface WrappedResult {
  output: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  error?: unknown;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  if (err == null) return 'Unknown error';
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function serializeError(err: unknown): string {
  if (err instanceof Error) {
    return JSON.stringify({
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause:
        err.cause instanceof Error
          ? {
              name: err.cause.name,
              message: err.cause.message,
            }
          : err.cause,
    });
  }
  if (typeof err === 'string') return JSON.stringify({ message: err });
  if (err == null) return JSON.stringify({ message: 'Unknown error' });
  try {
    return JSON.stringify(err);
  } catch {
    return JSON.stringify({ message: String(err) });
  }
}

function failureScores(
  scorerNames: string[],
  error: unknown,
): Record<string, ScorerResult> {
  const reason = `Task failed: ${errorMessage(error)}`;
  const scores: Record<string, ScorerResult> = {};
  for (const scorerName of scorerNames) {
    scores[scorerName] = { score: 0, reason };
  }
  return scores;
}

function createSemaphore(maxConcurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<void> {
      if (active < maxConcurrency) {
        active++;
        return;
      }
      return new Promise<void>((resolve) => queue.push(resolve));
    },
    release(): void {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    },
  };
}

async function wrapTask<T>(
  task: TaskFn<T>,
  input: T,
  timeoutMs: number,
): Promise<WrappedResult> {
  const start = performance.now();
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      task(input),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error('timeout exceeded')),
          timeoutMs,
        );
      }),
    ]);
    clearTimeout(timerId);
    const latencyMs = Math.round(performance.now() - start);
    return {
      output: result.output,
      latencyMs,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
    };
  } catch (err) {
    clearTimeout(timerId);
    const latencyMs = Math.round(performance.now() - start);
    return {
      output: '',
      latencyMs,
      tokensIn: 0,
      tokensOut: 0,
      error: err,
    };
  }
}

function clampScore(score: number, scorerName: string): number {
  if (score < 0 || score > 1) {
    console.warn(
      `Scorer "${scorerName}" returned out-of-range score ${score}, clamping to 0..1`,
    );
    return Math.max(0, Math.min(1, score));
  }
  return score;
}

export async function runEval<T>(config: EvalConfig<T>): Promise<RunSummary> {
  const {
    name,
    model,
    dataset: ds,
    task,
    scorers,
    store,
    suiteId,
    maxConcurrency = 10,
    batchSize,
    timeout = 30_000,
    trials = 1,
    threshold = 0.5,
  } = config;

  const emitter = config.emitter ?? new EvalEmitter();
  const resolvedSuiteId = suiteId ?? store.createSuite(name).id;
  const runId = store.createRun({
    suite_id: resolvedSuiteId,
    name,
    model,
    config: config.config,
  });

  const items: Array<{ index: number; input: T }> = [];
  let idx = 0;
  for await (const item of ds) {
    items.push({ index: idx++, input: item });
  }

  emitter.emit('run:start', { runId, totalCases: items.length, name, model });

  const semaphore = createSemaphore(maxConcurrency);
  const scorerNames = Object.keys(scorers);

  const allCaseScores: Array<{
    index: number;
    scores: Record<string, number>;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
  }> = [];

  const processItem = async ({ index, input }: { index: number; input: T }) => {
    await semaphore.acquire();
    try {
      emitter.emit('case:start', { runId, index, input });

      let finalResult: WrappedResult;
      let finalScores: Record<string, ScorerResult>;

      if (trials > 1) {
        const trialResults: Array<{
          result: WrappedResult;
          scores: Record<string, ScorerResult>;
        }> = [];

        for (let t = 0; t < trials; t++) {
          const result = await wrapTask(task, input, timeout);
          if (result.error) {
            trialResults.push({
              result,
              scores: failureScores(scorerNames, result.error),
            });
          } else {
            const scores: Record<string, ScorerResult> = {};
            for (const [sName, scorer] of Object.entries(scorers)) {
              const sr = await scorer({
                input,
                output: result.output,
                expected: (input as Record<string, unknown>).expected,
              });
              scores[sName] = {
                score: clampScore(sr.score, sName),
                reason: sr.reason,
                metadata: sr.metadata,
              };
            }
            trialResults.push({ result, scores });
          }
        }

        const lastSuccessful = [...trialResults]
          .reverse()
          .find((t) => !t.result.error);
        const baseResult =
          lastSuccessful?.result ??
          trialResults[trialResults.length - 1]!.result;
        finalResult = {
          output: baseResult.output,
          latencyMs: Math.round(
            trialResults.reduce((sum, t) => sum + t.result.latencyMs, 0) /
              trials,
          ),
          tokensIn: Math.round(
            trialResults.reduce((sum, t) => sum + t.result.tokensIn, 0) /
              trials,
          ),
          tokensOut: Math.round(
            trialResults.reduce((sum, t) => sum + t.result.tokensOut, 0) /
              trials,
          ),
          error: lastSuccessful ? undefined : baseResult.error,
        };

        finalScores = {};
        for (const sName of scorerNames) {
          const meanScore =
            trialResults.reduce((sum, t) => sum + t.scores[sName]!.score, 0) /
            trials;
          finalScores[sName] = {
            score: meanScore,
            reason:
              trialResults[trialResults.length - 1]!.scores[sName]?.reason,
            metadata:
              trialResults[trialResults.length - 1]!.scores[sName]?.metadata,
          };
        }
      } else {
        finalResult = await wrapTask(task, input, timeout);
        if (finalResult.error) {
          finalScores = failureScores(scorerNames, finalResult.error);
        } else {
          finalScores = {};
          for (const [sName, scorer] of Object.entries(scorers)) {
            const sr = await scorer({
              input,
              output: finalResult.output,
              expected: (input as Record<string, unknown>).expected,
            });
            finalScores[sName] = {
              score: clampScore(sr.score, sName),
              reason: sr.reason,
              metadata: sr.metadata,
            };
          }
        }
      }

      const caseId = crypto.randomUUID();

      const caseData: CaseData = {
        id: caseId,
        run_id: runId,
        idx: index,
        input,
        output: finalResult.output || null,
        expected: (input as Record<string, unknown>).expected,
        latency_ms: finalResult.latencyMs,
        tokens_in: finalResult.tokensIn,
        tokens_out: finalResult.tokensOut,
        error: finalResult.error
          ? serializeError(finalResult.error)
          : undefined,
      };
      store.saveCases([caseData]);

      const scoreDataList: ScoreData[] = scorerNames.map((sName) => ({
        id: crypto.randomUUID(),
        case_id: caseId,
        scorer_name: sName,
        score: finalScores[sName]!.score,
        reason: finalScores[sName]!.reason,
      }));
      store.saveScores(scoreDataList);

      allCaseScores.push({
        index,
        scores: Object.fromEntries(
          scorerNames.map((sName) => [sName, finalScores[sName]!.score]),
        ),
        latencyMs: finalResult.latencyMs,
        tokensIn: finalResult.tokensIn,
        tokensOut: finalResult.tokensOut,
      });

      if (finalResult.error) {
        emitter.emit('case:error', {
          runId,
          index,
          error: errorMessage(finalResult.error),
        });
      }

      emitter.emit('case:scored', {
        runId,
        index,
        input,
        output: finalResult.output,
        expected: (input as Record<string, unknown>).expected,
        scores: finalScores,
        error: finalResult.error,
        latencyMs: finalResult.latencyMs,
        tokensIn: finalResult.tokensIn,
        tokensOut: finalResult.tokensOut,
      });
    } finally {
      semaphore.release();
    }
  };

  const batches = batchSize
    ? Array.from({ length: Math.ceil(items.length / batchSize) }, (_, i) =>
        items.slice(i * batchSize, (i + 1) * batchSize),
      )
    : [items];

  try {
    for (const batch of batches) {
      await Promise.all(batch.map(processItem));
    }
  } catch (err) {
    store.finishRun(runId, 'failed');
    throw err;
  }

  const summary = computeSummary(allCaseScores, scorerNames, threshold);
  store.finishRun(runId, 'completed', summary);
  emitter.emit('run:end', { runId, summary });

  return summary;
}

function computeSummary(
  cases: Array<{
    index: number;
    scores: Record<string, number>;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
  }>,
  scorerNames: string[],
  threshold: number,
): RunSummary {
  const totalCases = cases.length;
  let passCount = 0;
  let failCount = 0;
  let totalLatencyMs = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  const scoreSums: Record<string, number> = {};
  for (const name of scorerNames) {
    scoreSums[name] = 0;
  }

  for (const c of cases) {
    totalLatencyMs += c.latencyMs;
    totalTokensIn += c.tokensIn;
    totalTokensOut += c.tokensOut;

    let allPass = true;
    for (const name of scorerNames) {
      const score = c.scores[name] ?? 0;
      scoreSums[name]! += score;
      if (score < threshold) allPass = false;
    }
    if (allPass) passCount++;
    else failCount++;
  }

  const meanScores: Record<string, number> = {};
  for (const name of scorerNames) {
    meanScores[name] = totalCases > 0 ? scoreSums[name]! / totalCases : 0;
  }

  return {
    totalCases,
    passCount,
    failCount,
    meanScores,
    totalLatencyMs,
    totalTokensIn,
    totalTokensOut,
  };
}
