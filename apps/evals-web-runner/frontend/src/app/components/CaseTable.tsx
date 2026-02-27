import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../shadcn/index.ts';
import { formatInputValue, truncate } from '../lib/format.ts';

interface ScoreEntry {
  scorer_name: string;
  score: number;
  reason: string | null;
}

interface CaseWithScores {
  id: string;
  run_id: string;
  idx: number;
  input: unknown;
  output: string | null;
  expected: unknown;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
  scores: ScoreEntry[];
}

interface CaseTableProps {
  cases: CaseWithScores[];
  scorerNames: string[];
  threshold?: number;
}

function normalizeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatCaseError(error: string | null): string | null {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const message =
        typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : null;
      const name =
        typeof (parsed as { name?: unknown }).name === 'string'
          ? (parsed as { name: string }).name
          : null;
      if (message) return name ? `${name}: ${message}` : message;
    }
    return JSON.stringify(parsed);
  } catch {
    return error;
  }
}

function formatCaseErrorDetails(error: string | null): string | null {
  if (!error) return null;
  try {
    const parsed = JSON.parse(error);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      const stack =
        typeof (parsed as { stack?: unknown }).stack === 'string'
          ? (parsed as { stack: string }).stack
          : null;
      if (stack) return stack;
      return JSON.stringify(parsed, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return error;
  }
}

function fallbackFailureReason(
  caseData: CaseWithScores,
  scorerName: string,
  score: number,
  threshold: number,
): string {
  const expected = truncate(formatInputValue(caseData.expected), 140);
  const output = truncate(caseData.output ?? '', 140);

  if (scorerName === 'exactMatch') {
    return `Output did not exactly match expected. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'includes') {
    return `Output did not include expected text. Expected snippet: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'levenshtein') {
    return `Similarity score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)}. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }
  if (scorerName === 'jsonMatch') {
    return `Output JSON did not match expected JSON. Expected: ${expected}. Output: ${output || '<empty>'}.`;
  }

  return `Score ${score.toFixed(3)} is below threshold ${threshold.toFixed(3)}. Expected: ${expected}. Output: ${output || '<empty>'}.`;
}

function buildOutcomeReason(
  caseData: CaseWithScores,
  threshold: number,
): string {
  const errorText = formatCaseError(caseData.error);
  if (errorText) return `Task error: ${errorText}`;

  const failing = caseData.scores.filter((s) => s.score < threshold);
  if (failing.length > 0) {
    return failing
      .map((s) => {
        const reason =
          normalizeReason(s.reason) ??
          fallbackFailureReason(caseData, s.scorer_name, s.score, threshold);
        return `${s.scorer_name} (${s.score.toFixed(3)}): ${reason}`;
      })
      .join(' | ');
  }

  const passingWithReasons = caseData.scores
    .filter((s) => s.score >= threshold)
    .map((s) => ({
      scorer: s.scorer_name,
      reason: normalizeReason(s.reason),
      score: s.score,
    }))
    .filter((s) => s.reason);

  if (passingWithReasons.length > 0) {
    return passingWithReasons
      .map((s) => `${s.scorer} (${s.score.toFixed(3)}): ${s.reason}`)
      .join(' | ');
  }

  if (caseData.scores.length > 0) {
    return `Passed all ${caseData.scores.length} scorer(s).`;
  }

  return 'No scorer output available.';
}

export function CaseTable({
  cases,
  scorerNames,
  threshold = 0.5,
}: CaseTableProps) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Input</TableHead>
            <TableHead>Output</TableHead>
            <TableHead>Expected</TableHead>
            {scorerNames.map((name) => (
              <TableHead key={name}>{name}</TableHead>
            ))}
            <TableHead>Why</TableHead>
            <TableHead>Latency</TableHead>
            <TableHead>Runtime Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cases.map((c) => {
            const passed = c.scores.every((s) => s.score >= threshold);
            const status = c.error ? 'error' : passed ? 'pass' : 'fail';
            const statusLabel =
              status === 'pass'
                ? 'PASS'
                : status === 'fail'
                  ? 'FAIL (score)'
                  : 'ERROR (runtime)';
            const scoreMap = new Map(
              c.scores.map((s) => [s.scorer_name, s]),
            );
            const errorSummary = formatCaseError(c.error);
            const errorDetails = formatCaseErrorDetails(c.error);

            return (
              <TableRow key={c.id}>
                <TableCell className="text-muted-foreground">
                  {c.idx}
                </TableCell>
                <TableCell>
                  <span
                    className={`text-xs font-medium ${
                      status === 'pass'
                        ? 'text-green-600'
                        : status === 'fail'
                          ? 'text-destructive'
                          : 'text-yellow-600'
                    }`}
                  >
                    {statusLabel}
                  </span>
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  {truncate(formatInputValue(c.input))}
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  {c.output ? truncate(c.output) : '\u2014'}
                </TableCell>
                <TableCell className="max-w-xs truncate">
                  {c.expected != null
                    ? truncate(formatInputValue(c.expected))
                    : '\u2014'}
                </TableCell>
                {scorerNames.map((name) => {
                  const s = scoreMap.get(name);
                  const score = s?.score ?? 0;
                  const reason = normalizeReason(s?.reason);
                  return (
                    <TableCell
                      key={name}
                      className={`font-mono text-xs ${
                        score >= threshold
                          ? 'text-green-600'
                          : 'text-destructive'
                      }`}
                      title={reason ?? undefined}
                    >
                      {score.toFixed(3)}
                    </TableCell>
                  );
                })}
                <TableCell className="max-w-sm whitespace-pre-wrap text-xs">
                  {buildOutcomeReason(c, threshold)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {c.latency_ms}ms
                </TableCell>
                <TableCell className="text-destructive max-w-xs text-xs">
                  {errorSummary ? (
                    <details>
                      <summary className="cursor-pointer">
                        {errorSummary}
                      </summary>
                      <pre className="text-destructive/80 mt-1 whitespace-pre-wrap font-mono text-[10px]">
                        {errorDetails}
                      </pre>
                    </details>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
