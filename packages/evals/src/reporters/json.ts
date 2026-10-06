import { appendFileSync, mkdirSync } from 'node:fs';

import { stringifyUnknown } from './format.ts';
import {
  getReportPath,
  resolveOutputDir,
  writeRunReportFile,
} from './shared.ts';
import type { Reporter } from './types.ts';

export interface JsonReporterOptions {
  outputDir?: string;
  pretty?: boolean;
}

export function jsonReporter(options?: JsonReporterOptions): Reporter {
  const outputDir = resolveOutputDir(options?.outputDir);
  const pretty = options?.pretty ?? true;
  // evaluate() with several models shares one reporter across concurrent
  // runs, so each run streams its cases to its own file.
  const streamFiles = new Map<string, string>();

  return {
    onRunStart(data) {
      mkdirSync(outputDir, { recursive: true });
      streamFiles.set(
        data.runId,
        getReportPath(outputDir, data.name, data.runId, 'jsonl'),
      );
    },
    onCaseEnd(data) {
      const streamFile = streamFiles.get(data.runId);
      if (streamFile === undefined) {
        throw new Error(
          `jsonReporter received a case for run ${data.runId} before its onRunStart`,
        );
      }
      const line = stringifyUnknown(data, { space: 0, fallback: 'null' });
      appendFileSync(streamFile, line + '\n', 'utf-8');
    },
    async onRunEnd(data) {
      streamFiles.delete(data.runId);
      const content = stringifyUnknown(data, {
        space: pretty ? 2 : 0,
        fallback: 'null',
      });
      await writeRunReportFile(
        outputDir,
        data.name,
        data.runId,
        'json',
        content,
      );
    },
  };
}
