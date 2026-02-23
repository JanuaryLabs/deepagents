import type { ScorerResult } from '../scorers/index.ts';
import type { RunSummary } from '../store/index.ts';

export type Verbosity = 'quiet' | 'normal' | 'verbose';

export interface RunStartData {
  runId: string;
  name: string;
  model: string;
  totalCases: number;
}

export interface CaseResult {
  runId: string;
  index: number;
  input: unknown;
  output: string;
  expected: unknown;
  scores: Record<string, ScorerResult>;
  error: unknown;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface RunEndData {
  runId: string;
  name: string;
  model: string;
  summary: RunSummary;
  cases: CaseResult[];
  threshold: number;
}

export interface Reporter {
  onRunStart?(data: RunStartData): void;
  onCaseEnd?(data: CaseResult): void;
  onRunEnd?(data: RunEndData): void | Promise<void>;
}
