import chalk from 'chalk';

import {
  formatDuration,
  formatErrorValue,
  formatTokens,
  stringifyUnknown,
} from './format.ts';
import { getCaseStatus } from './shared.ts';
import type { CaseResult, Reporter, RunEndData, Verbosity } from './types.ts';

export interface ConsoleReporterOptions {
  verbosity?: Verbosity;
}

const BAR_WIDTH = 20;

function renderProgressBar(
  completed: number,
  total: number,
  elapsedMs: number,
): string {
  const pct = total > 0 ? completed / total : 0;
  const filled = Math.round(pct * BAR_WIDTH);
  const bar = '\u2593'.repeat(filled) + '\u2591'.repeat(BAR_WIDTH - filled);
  const pctStr = `${(pct * 100).toFixed(0)}%`;
  return `  ${bar} ${pctStr} (${completed}/${total}) ${formatDuration(elapsedMs)}`;
}

function statusLabel(status: 'pass' | 'fail' | 'error'): string {
  if (status === 'pass') return chalk.green('PASS');
  if (status === 'error') return chalk.yellow('ERROR');
  return chalk.red('FAIL');
}

export function consoleReporter(options?: ConsoleReporterOptions): Reporter {
  const verbosity = options?.verbosity ?? 'normal';

  let totalCases = 0;
  let completed = 0;
  let startTime = 0;

  return {
    onRunStart(data) {
      totalCases = data.totalCases;
      completed = 0;
      startTime = Date.now();

      if (verbosity !== 'quiet') {
        const label = data.name;
        console.log('');
        console.log(
          `  ${chalk.dim('\u2500\u2500')} ${chalk.bold(label)} ${chalk.dim('\u2500'.repeat(Math.max(0, 56 - label.length)))}`,
        );
        console.log(`  ${chalk.dim(`Running ${data.totalCases} cases...`)}`);
        console.log('');
      }
    },

    onCaseEnd() {
      completed++;
      if (verbosity !== 'quiet') {
        const elapsed = Date.now() - startTime;
        process.stdout.write(
          `\r${renderProgressBar(completed, totalCases, elapsed)}`,
        );
      }
    },

    onRunEnd(data) {
      if (verbosity !== 'quiet') {
        process.stdout.write('\r' + ' '.repeat(70) + '\r');
      }

      renderSummaryTable(data);

      if (verbosity === 'quiet') return;

      const sorted = [...data.cases].sort((a, b) => a.index - b.index);

      if (verbosity === 'verbose') {
        for (const c of sorted) {
          renderCaseDetail(c, data.threshold, {
            includeIO: true,
            maxStringLength: 20_000,
          });
        }
      } else {
        renderFailuresByScorer(sorted, data.threshold);
      }
    },
  };
}

function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function truncateString(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\u2026';
}

function stringifyRationale(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' | ');
  }

  return undefined;
}

function scoreReasonWithMetadata(score: {
  reason?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const reason = score.reason?.trim();
  if (reason) return reason;
  return stringifyRationale(score.metadata?.['rationale']);
}

function renderSummaryTable(data: RunEndData): void {
  const { summary } = data;
  const passRate =
    summary.totalCases > 0
      ? ((summary.passCount / summary.totalCases) * 100).toFixed(1)
      : '0.0';

  console.log('');
  console.log(chalk.bold('  Summary'));
  console.log(chalk.dim('  ' + '\u2500'.repeat(60)));
  console.log(`  ${chalk.dim('Eval:')}      ${data.name}`);
  console.log(`  ${chalk.dim('Model:')}     ${data.model}`);
  console.log(`  ${chalk.dim('Threshold:')} ${data.threshold}`);
  console.log(`  ${chalk.dim('Cases:')}     ${summary.totalCases}`);
  console.log(
    `  ${chalk.dim('Pass/Fail:')} ${chalk.green(String(summary.passCount))} / ${chalk.red(String(summary.failCount))} ${chalk.dim(`(${passRate}%)`)}`,
  );
  console.log(
    `  ${chalk.dim('Duration:')}  ${formatDuration(summary.totalLatencyMs)}`,
  );
  console.log(
    `  ${chalk.dim('Tokens:')}    ${chalk.dim('In:')} ${formatTokens(summary.totalTokensIn)}  ${chalk.dim('Out:')} ${formatTokens(summary.totalTokensOut)}  ${chalk.dim('Total:')} ${formatTokens(summary.totalTokensIn + summary.totalTokensOut)}`,
  );

  const scoreEntries = Object.entries(summary.meanScores);
  if (scoreEntries.length > 0) {
    console.log('');
    console.log(chalk.bold('  Scores'));
    for (const [name, score] of scoreEntries) {
      const scoreColor = score >= data.threshold ? chalk.green : chalk.red;
      console.log(
        `    ${chalk.dim(name + ':')}${' '.repeat(Math.max(1, 12 - name.length))}${scoreColor(score.toFixed(3))}`,
      );
    }
  }

  console.log(chalk.dim('  ' + '\u2500'.repeat(60)));
  console.log('');
}

function renderCaseDetail(
  c: CaseResult,
  threshold: number,
  options?: {
    includeIO?: boolean;
    maxStringLength?: number;
  },
): void {
  const entries = Object.entries(c.scores);
  const status = getCaseStatus(c, threshold);
  const prefix = statusLabel(status);
  const includeIO = options?.includeIO ?? false;
  const maxStringLength = options?.maxStringLength ?? 4_000;

  const meta = `${chalk.dim(formatDuration(c.latencyMs))}  ${chalk.dim(`${c.tokensIn}/${c.tokensOut} tokens`)}`;
  console.log(`  ${prefix} ${chalk.dim(`Case #${c.index}`)}  ${meta}`);

  const inputStr = stringifyUnknown(c.input, {
    space: 2,
    fallback: String(c.input),
  });
  console.log(`    ${chalk.dim('Input:')}`);
  console.log(indentBlock(truncateString(inputStr, maxStringLength), 6));

  if (includeIO) {
    console.log(`    ${chalk.dim('Output:')}`);
    console.log(indentBlock(truncateString(c.output, maxStringLength), 6));
    console.log(`    ${chalk.dim('Expected:')}`);
    const expectedStrRaw = stringifyUnknown(c.expected, {
      space: 2,
      fallback: String(c.expected),
    });
    console.log(
      indentBlock(truncateString(expectedStrRaw, maxStringLength), 6),
    );
  }

  for (const [name, s] of entries) {
    const scoreColor = s.score >= threshold ? chalk.green : chalk.red;
    const reason = scoreReasonWithMetadata(s);
    const reasonStr = reason ? ` \u2014 ${reason}` : '';
    console.log(
      `    ${chalk.dim(name + ':')} ${scoreColor(s.score.toFixed(3))}${reasonStr}`,
    );
  }

  if (c.error) {
    console.log(`    ${chalk.dim('Error:')}`);
    const errorStr = formatErrorValue(c.error);
    console.log(`      ${chalk.red(errorStr)}`);
  }

  console.log('');
}

function renderFailuresByScorer(cases: CaseResult[], threshold: number): void {
  const scorerNames = new Set<string>();
  for (const c of cases) {
    for (const name of Object.keys(c.scores)) {
      scorerNames.add(name);
    }
  }

  let hasFailures = false;

  for (const scorer of scorerNames) {
    const failing = cases.filter((c) => {
      const s = c.scores[scorer];
      return (
        (s && s.score < threshold) || getCaseStatus(c, threshold) === 'error'
      );
    });

    if (failing.length === 0) continue;

    if (!hasFailures) {
      console.log(chalk.dim('  Failing by scorer:'));
      console.log('');
      hasFailures = true;
    }

    console.log(
      `  ${chalk.bold(scorer)} ${chalk.dim(`(${failing.length} failures)`)}`,
    );
    console.log(chalk.dim('  ' + '\u2500'.repeat(40)));

    for (const c of failing) {
      renderCaseDetail(c, threshold, {
        includeIO: true,
        maxStringLength: 4_000,
      });
    }
  }
}
