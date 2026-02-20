import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RefactorFinding } from './find-refactor-targets.ts';

export interface RefactorFix {
  type: 'boundaries' | 'typing';
  file: string;
  before: string;
  after: string;
  note: string;
}

export interface ApplySafeRefactorsInput {
  cwd: string;
  findings: RefactorFinding[];
}

export interface ApplySafeRefactorsResult {
  fixesApplied: RefactorFix[];
}

function lineFromIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function pushFix(
  fixes: RefactorFix[],
  type: 'boundaries' | 'typing',
  file: string,
  before: string,
  after: string,
  note: string,
): void {
  fixes.push({
    type,
    file,
    before,
    after,
    note,
  });
}

export async function applySafeRefactors(
  input: ApplySafeRefactorsInput,
): Promise<ApplySafeRefactorsResult> {
  const files = new Set(
    input.findings
      .map((finding) => finding.file)
      .filter((value): value is string => Boolean(value)),
  );

  const fixesApplied: RefactorFix[] = [];

  for (const relPath of files) {
    const absPath = path.join(input.cwd, relPath);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    let updated = content;

    updated = updated.replace(
      /(['"])@deepagents\/([^/'"\\]+)\/src(?:\/index(?:\.ts)?)?\1/g,
      (_full, quote, pkg) => {
        const before = `${quote}@deepagents/${pkg}/src${quote}`;
        const after = `${quote}@deepagents/${pkg}${quote}`;
        pushFix(
          fixesApplied,
          'boundaries',
          normalizePath(relPath),
          before,
          after,
          'Promoted deep source import to package public entrypoint.',
        );
        return `${quote}@deepagents/${pkg}${quote}`;
      },
    );

    updated = updated.replace(/\bas any\b/g, (match, index: number) => {
      const line = lineFromIndex(updated, index);
      pushFix(
        fixesApplied,
        'typing',
        normalizePath(relPath),
        `${match} (line ${line})`,
        'as unknown',
        'Replaced unsafe cast with unknown for boundary-safe narrowing.',
      );
      return 'as unknown';
    });

    updated = updated.replace(
      /Record<\s*string\s*,\s*any\s*>/g,
      (match, index: number) => {
        const line = lineFromIndex(updated, index);
        pushFix(
          fixesApplied,
          'typing',
          normalizePath(relPath),
          `${match} (line ${line})`,
          'Record<string, unknown>',
          'Strengthened dictionary typing for safer boundary handling.',
        );
        return 'Record<string, unknown>';
      },
    );

    updated = updated.replace(
      /:\s*any(\s*[,)=;])/g,
      (_match, suffix: string, index: number) => {
        const line = lineFromIndex(updated, index);
        pushFix(
          fixesApplied,
          'typing',
          normalizePath(relPath),
          `: any${suffix} (line ${line})`,
          `: unknown${suffix}`,
          'Replaced loose any annotation with unknown.',
        );
        return `: unknown${suffix}`;
      },
    );

    if (updated === content) continue;
    await fs.writeFile(absPath, updated, 'utf8');
  }

  return { fixesApplied };
}
