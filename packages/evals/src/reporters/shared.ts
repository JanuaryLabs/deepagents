import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateFilename } from './format.ts';
import type { CaseResult, Reporter, RunEndData } from './types.ts';

const DEFAULT_OUTPUT_DIR = '.evals/reports';

export function resolveOutputDir(outputDir?: string): string {
  return outputDir ?? DEFAULT_OUTPUT_DIR;
}

export function getReportPath(
  outputDir: string,
  name: string,
  runId: string,
  ext: string,
): string {
  return join(outputDir, generateFilename(name, runId, ext));
}

export async function writeRunReportFile(
  outputDir: string,
  name: string,
  runId: string,
  ext: string,
  content: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await writeFile(getReportPath(outputDir, name, runId, ext), content, 'utf-8');
}

export function getCaseStatus(
  result: CaseResult,
  threshold: number,
): 'error' | 'pass' | 'fail' {
  if (result.error) return 'error';
  const passed = Object.values(result.scores).every(
    (s) => s.score >= threshold,
  );
  return passed ? 'pass' : 'fail';
}

export function createRunEndFileReporter(options: {
  outputDir?: string;
  ext: string;
  render: (data: RunEndData) => string | Promise<string>;
}): Reporter {
  const outputDir = resolveOutputDir(options.outputDir);

  return {
    async onRunEnd(data) {
      const content = await options.render(data);
      await writeRunReportFile(
        outputDir,
        data.name,
        data.runId,
        options.ext,
        content,
      );
    },
  };
}
