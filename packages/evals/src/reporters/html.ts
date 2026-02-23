import {
  formatDuration,
  formatErrorValue,
  formatInputValue,
  formatTokens,
} from './format.ts';
import { createRunEndFileReporter, getCaseStatus } from './shared.ts';
import type { Reporter, RunEndData } from './types.ts';

export interface HtmlReporterOptions {
  outputDir?: string;
}

export function htmlReporter(options?: HtmlReporterOptions): Reporter {
  return createRunEndFileReporter({
    outputDir: options?.outputDir,
    ext: 'html',
    render: renderHtml,
  });
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(data: RunEndData): string {
  const { summary } = data;
  const scorerNames = Object.keys(summary.meanScores);

  const caseRows = data.cases
    .map((c) => {
      const status = getCaseStatus(c, data.threshold);
      const statusLabel =
        status === 'error' ? 'ERROR' : status === 'pass' ? 'PASS' : 'FAIL';
      const scoresCells = scorerNames
        .map((name) => {
          const s = c.scores[name];
          const score = s?.score ?? 0;
          const cls = score >= data.threshold ? 'pass' : 'fail';
          const reason = s?.reason ? ` title="${esc(s.reason)}"` : '';
          return `<td class="${cls}"${reason}>${score.toFixed(3)}</td>`;
        })
        .join('');

      return `<tr class="${status}">
        <td>${c.index}</td>
        <td class="${status}">${statusLabel}</td>
        <td class="text">${esc(formatInputValue(c.input).slice(0, 120))}</td>
        <td class="text">${esc(c.output.slice(0, 120))}</td>
        ${scoresCells}
        <td>${c.latencyMs}ms</td>
        <td class="error-text">${c.error ? esc(formatErrorValue(c.error)) : ''}</td>
      </tr>`;
    })
    .join('\n');

  const scorerHeaders = scorerNames.map((n) => `<th>${esc(n)}</th>`).join('');
  const meanScoreRows = Object.entries(summary.meanScores)
    .map(
      ([name, score]) =>
        `<tr><td>${esc(name)}</td><td>${score.toFixed(3)}</td></tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(data.name)} — Eval Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8f9fa; color: #1a1a1a; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .meta { color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }
  .meta span { margin-right: 1.5rem; }
  .summary-table, .cases-table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
  .summary-table th, .summary-table td,
  .cases-table th, .cases-table td { padding: 0.5rem 0.75rem; border: 1px solid #ddd; text-align: left; font-size: 0.85rem; }
  .summary-table th, .cases-table th { background: #f1f3f5; font-weight: 600; }
  .cases-table .text { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cases-table .error-text { max-width: 480px; white-space: pre-wrap; word-break: break-word; }
  .pass { color: #2b8a3e; }
  .fail { color: #c92a2a; }
  .error { color: #e67700; }
  tr.pass:hover, tr.fail:hover, tr.error:hover { background: #f1f3f5; }
  td.pass { background: #ebfbee; }
  td.fail { background: #fff5f5; }
  h2 { font-size: 1.2rem; margin: 1.5rem 0 0.75rem; }
</style>
</head>
<body>
  <h1>${esc(data.name)}</h1>
  <div class="meta">
    <span><strong>Model:</strong> ${esc(data.model)}</span>
    <span><strong>Cases:</strong> ${summary.totalCases}</span>
    <span><strong>Pass:</strong> ${summary.passCount}</span>
    <span><strong>Fail:</strong> ${summary.failCount}</span>
    <span><strong>Duration:</strong> ${formatDuration(summary.totalLatencyMs)}</span>
    <span><strong>Tokens:</strong> ${formatTokens(summary.totalTokensIn + summary.totalTokensOut)}</span>
  </div>

  <h2>Mean Scores</h2>
  <table class="summary-table">
    <thead><tr><th>Scorer</th><th>Mean</th></tr></thead>
    <tbody>${meanScoreRows}</tbody>
  </table>

  <h2>Cases</h2>
  <table class="cases-table">
    <thead>
      <tr>
        <th>#</th>
        <th>Status</th>
        <th>Input</th>
        <th>Output</th>
        ${scorerHeaders}
        <th>Latency</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      ${caseRows}
    </tbody>
  </table>
</body>
</html>`;
}
