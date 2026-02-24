import { escapeCsv } from './format.ts';
import { createRunEndFileReporter, getCaseStatus } from './shared.ts';
import type { Reporter } from './types.ts';

export interface CsvReporterOptions {
  outputDir?: string;
}

export function csvReporter(options?: CsvReporterOptions): Reporter {
  return createRunEndFileReporter({
    outputDir: options?.outputDir,
    ext: 'csv',
    render(data) {
      const scorerNames = Object.keys(data.summary.meanScores);

      const headerParts = [
        'index',
        'status',
        'input',
        'output',
        'expected',
        'error',
        'latency_ms',
        'tokens_in',
        'tokens_out',
      ];
      for (const name of scorerNames) {
        headerParts.push(`${name}_score`, `${name}_reason`);
      }

      const rows = [headerParts.join(',')];

      for (const c of data.cases) {
        const status = getCaseStatus(c, data.threshold);
        const parts = [
          String(c.index),
          status,
          escapeCsv(c.input),
          escapeCsv(c.output),
          escapeCsv(c.expected),
          escapeCsv(c.error ?? ''),
          String(c.latencyMs),
          String(c.tokensIn),
          String(c.tokensOut),
        ];
        for (const name of scorerNames) {
          const s = c.scores[name];
          parts.push(String(s?.score ?? ''), escapeCsv(s?.reason ?? ''));
        }
        rows.push(parts.join(','));
      }

      return rows.join('\n') + '\n';
    },
  });
}
