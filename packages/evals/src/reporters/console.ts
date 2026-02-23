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

export function consoleReporter(options?: ConsoleReporterOptions): Reporter {
  const verbosity = options?.verbosity ?? 'normal';

  let totalCases = 0;
  let completed = 0;

  return {
    onRunStart(data) {
      totalCases = data.totalCases;
      completed = 0;
    },

    onCaseEnd() {
      completed++;
      if (verbosity !== 'quiet') {
        process.stdout.write(
          `\r  ${chalk.dim(`[${completed}/${totalCases}]`)}`,
        );
      }
    },

    onRunEnd(data) {
      if (verbosity !== 'quiet') {
        process.stdout.write('\r' + ' '.repeat(30) + '\r');
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
        const failing = sorted.filter(
          (c) => getCaseStatus(c, data.threshold) !== 'pass',
        );
        if (failing.length > 0) {
          console.log(chalk.dim(`  Failing cases (${failing.length}):`));
          console.log('');
          for (const c of failing) {
            renderCaseDetail(c, data.threshold, {
              includeIO: true,
              maxStringLength: 4_000,
            });
          }
        }
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
  return text.slice(0, maxLength) + '…';
}

function renderSummaryTable(data: RunEndData): void {
  const { summary } = data;
  const scoreStr = Object.entries(summary.meanScores)
    .map(([name, score]) => `${name}: ${score.toFixed(3)}`)
    .join(', ');

  console.log('');
  console.log(chalk.bold('  Summary'));
  console.log(chalk.dim('  ' + '─'.repeat(60)));
  console.log(`  ${chalk.dim('Eval:')}     ${data.name}`);
  console.log(`  ${chalk.dim('Model:')}    ${data.model}`);
  console.log(`  ${chalk.dim('Cases:')}    ${summary.totalCases}`);
  console.log(
    `  ${chalk.dim('Pass/Fail:')} ${chalk.green(String(summary.passCount))} / ${chalk.red(String(summary.failCount))}`,
  );
  console.log(`  ${chalk.dim('Scores:')}   ${scoreStr}`);
  console.log(
    `  ${chalk.dim('Duration:')} ${formatDuration(summary.totalLatencyMs)}`,
  );
  console.log(
    `  ${chalk.dim('Tokens:')}   ${formatTokens(summary.totalTokensIn + summary.totalTokensOut)}`,
  );
  console.log(chalk.dim('  ' + '─'.repeat(60)));
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
  const failed = entries.some(([, s]) => s.score < threshold);
  const prefix = failed ? chalk.red('FAIL') : chalk.green('PASS');
  const includeIO = options?.includeIO ?? false;
  const maxStringLength = options?.maxStringLength ?? 4_000;

  console.log(`  ${prefix} ${chalk.dim(`Case #${c.index}`)}`);
  const inputStr = stringifyUnknown(c.input, {
    space: 2,
    fallback: String(c.input),
  });
  console.log(`    ${chalk.dim('Input:')}  ${inputStr}`);

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
    const reasonStr = s.reason ? ` — ${s.reason}` : '';
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
