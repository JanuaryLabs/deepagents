export { Dataset, dataset, hf } from './dataset/index.ts';
export type { HfOptions, PredicateFn, TransformFn } from './dataset/index.ts';

export {
  all,
  any,
  exactMatch,
  factuality,
  includes,
  jsonMatch,
  levenshtein,
  llmJudge,
  regex,
  weighted,
} from './scorers/index.ts';
export type { Scorer, ScorerArgs, ScorerResult } from './scorers/index.ts';

export { RunStore } from './store/index.ts';
export type {
  CaseData,
  CaseRow,
  CaseWithScores,
  PromptRow,
  RunRow,
  RunSummary,
  ScoreData,
  ScoreRow,
  SuiteRow,
} from './store/index.ts';

export { EvalEmitter, runEval } from './engine/index.ts';
export type {
  EngineEvents,
  EvalConfig,
  TaskFn,
  TaskResult,
} from './engine/index.ts';

export { compareRuns } from './comparison/index.ts';
export type {
  CaseDiff,
  ChangeType,
  CompareOptions,
  ComparisonResult,
  CostDelta,
  ScorerSummary,
} from './comparison/index.ts';

export {
  consoleReporter,
  csvReporter,
  htmlReporter,
  jsonReporter,
  markdownReporter,
} from './reporters/index.ts';
export type {
  CaseResult,
  ConsoleReporterOptions,
  CsvReporterOptions,
  HtmlReporterOptions,
  JsonReporterOptions,
  MarkdownReporterOptions,
  Reporter,
  RunEndData,
  RunStartData,
  Verbosity,
} from './reporters/index.ts';

export { evaluate } from './evaluate/index.ts';
export type { EvaluateOptions, EvaluateEachOptions } from './evaluate/index.ts';
