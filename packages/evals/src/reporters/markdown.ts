import {
  formatDuration,
  formatErrorValue,
  formatInputValue,
  formatTokens,
} from './format.ts';
import { createRunEndFileReporter, getCaseStatus } from './shared.ts';
import type { Reporter } from './types.ts';

export interface MarkdownReporterOptions {
  outputDir?: string;
}

export function markdownReporter(options?: MarkdownReporterOptions): Reporter {
  return createRunEndFileReporter({
    outputDir: options?.outputDir,
    ext: 'md',
    render(data) {
      const { summary } = data;
      const scorerNames = Object.keys(summary.meanScores);
      const lines: string[] = [];
      const passRate =
        summary.totalCases > 0
          ? ((summary.passCount / summary.totalCases) * 100).toFixed(1)
          : '0.0';

      lines.push(`# ${data.name}`);
      lines.push('');
      lines.push(`**Model:** ${data.model}`);
      lines.push(`**Threshold:** ${data.threshold}`);
      lines.push(
        `**Cases:** ${summary.totalCases} (${summary.passCount} pass, ${summary.failCount} fail, ${passRate}%)`,
      );
      lines.push(`**Duration:** ${formatDuration(summary.totalLatencyMs)}`);
      lines.push(
        `**Tokens:** In: ${formatTokens(summary.totalTokensIn)} | Out: ${formatTokens(summary.totalTokensOut)} | Total: ${formatTokens(summary.totalTokensIn + summary.totalTokensOut)}`,
      );
      lines.push('');

      lines.push('## Scores');
      lines.push('');
      lines.push('| Scorer | Mean |');
      lines.push('|--------|------|');
      for (const [name, score] of Object.entries(summary.meanScores)) {
        lines.push(`| ${name} | ${score.toFixed(3)} |`);
      }
      lines.push('');

      lines.push('## Cases');
      lines.push('');

      const caseHeader = [
        '#',
        'Status',
        'Input',
        ...scorerNames,
        'Latency',
        'Tokens',
        'Error',
      ];
      lines.push(`| ${caseHeader.join(' | ')} |`);
      lines.push(`| ${caseHeader.map(() => '---').join(' | ')} |`);

      for (const c of data.cases) {
        const statusValue = getCaseStatus(c, data.threshold);
        const status =
          statusValue === 'error'
            ? '🔴 Error'
            : statusValue === 'pass'
              ? '✅ Pass'
              : '❌ Fail';
        const input = formatInputValue(c.input).slice(0, 60);
        const scores = scorerNames.map(
          (name) => c.scores[name]?.score.toFixed(3) ?? '-',
        );
        const error = c.error
          ? formatErrorValue(c.error)
              .replace(/\r?\n/g, '<br>')
              .replace(/\|/g, '\\|')
          : '-';
        const row = [
          String(c.index),
          status,
          input,
          ...scores,
          formatDuration(c.latencyMs),
          `${c.tokensIn}/${c.tokensOut}`,
          error,
        ];
        lines.push(`| ${row.join(' | ')} |`);
      }
      lines.push('');

      return lines.join('\n');
    },
  });
}
