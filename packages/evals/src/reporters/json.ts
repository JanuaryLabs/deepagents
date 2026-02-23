import { appendFile, mkdir } from 'node:fs/promises';

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
  let streamFilename = '';

  return {
    async onRunStart(data) {
      await mkdir(outputDir, { recursive: true });
      streamFilename = getReportPath(outputDir, data.name, data.runId, 'jsonl');
    },
    async onCaseEnd(data) {
      const line = stringifyUnknown(data, { space: 0, fallback: 'null' });
      await appendFile(streamFilename, line + '\n', 'utf-8');
    },
    async onRunEnd(data) {
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
