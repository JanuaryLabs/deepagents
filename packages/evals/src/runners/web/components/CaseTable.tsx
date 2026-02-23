import type { FC } from 'hono/jsx';
import { formatInputValue, truncate } from '../../../reporters/format.ts';
import type { CaseWithScores } from '../../../store/index.ts';

interface CaseTableProps {
  cases: CaseWithScores[];
  scorerNames: string[];
  threshold?: number;
  tbodyId?: string;
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

function buildOutcomeReason(caseData: CaseWithScores, threshold: number): string {
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

export const CaseTable: FC<CaseTableProps> = ({
  cases,
  scorerNames,
  threshold = 0.5,
  tbodyId,
}) => (
  <div class="overflow-x-auto rounded-box border border-base-content/5 bg-base-100">
    <table class="table table-zebra table-pin-rows table-sm">
      <thead>
        <tr>
          <th>#</th>
          <th>Status</th>
          <th>Input</th>
          <th>Output</th>
          <th>Expected</th>
          {scorerNames.map((name) => (
            <th>{name}</th>
          ))}
          <th>Why</th>
          <th>Latency</th>
          <th>Runtime Error</th>
        </tr>
      </thead>
      <tbody id={tbodyId}>
        {cases.map((c) => {
          const passed = c.scores.every((s) => s.score >= threshold);
          const status = c.error ? 'error' : passed ? 'pass' : 'fail';
          const statusLabel =
            status === 'pass'
              ? 'PASS'
              : status === 'fail'
                ? 'FAIL (score)'
                : 'ERROR (runtime)';
          const scoreMap = new Map(c.scores.map((s) => [s.scorer_name, s]));
          const errorSummary = formatCaseError(c.error);
          const errorDetails = formatCaseErrorDetails(c.error);

          return (
            <tr>
              <td class="text-base-content/60">{c.idx}</td>
              <td>
                <span
                  class={`text-xs font-medium ${
                    status === 'pass'
                      ? 'text-success'
                      : status === 'fail'
                        ? 'text-error'
                        : 'text-warning'
                  }`}
                >
                  {statusLabel}
                </span>
              </td>
              <td class="max-w-xs truncate">{truncate(formatInputValue(c.input))}</td>
              <td class="max-w-xs truncate">{c.output ? truncate(c.output) : '—'}</td>
              <td class="max-w-xs truncate">
                {c.expected != null ? truncate(formatInputValue(c.expected)) : '—'}
              </td>
              {scorerNames.map((name) => {
                const s = scoreMap.get(name);
                const score = s?.score ?? 0;
                const reason = normalizeReason(s?.reason);
                return (
                  <td
                    class={`font-mono text-xs ${
                      score >= threshold ? 'text-success' : 'text-error'
                    }`}
                    title={reason ?? undefined}
                  >
                    {score.toFixed(3)}
                  </td>
                );
              })}
              <td class="max-w-sm text-xs whitespace-pre-wrap">
                {buildOutcomeReason(c, threshold)}
              </td>
              <td class="text-base-content/60">{c.latency_ms}ms</td>
              <td class="max-w-xs text-error text-xs">
                {errorSummary ? (
                  <details>
                    <summary class="cursor-pointer">{errorSummary}</summary>
                    <pre class="mt-1 whitespace-pre-wrap font-mono text-[10px] text-error/80">
                      {errorDetails}
                    </pre>
                  </details>
                ) : (
                  ''
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
