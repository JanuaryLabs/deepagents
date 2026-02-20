import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Mode = 'on-demand' | 'scheduled';

export interface RefactorFinding {
  id: string;
  title: string;
  category: 'boundaries' | 'reuse' | 'typing';
  severity: 'low' | 'medium' | 'high';
  principle: 'boundaries' | 'reuse' | 'typing';
  packageName?: string;
  file?: string;
  line?: number;
  details: string;
  suggestedFix?: string;
}

export interface RefactorEvidence {
  type: 'analysis' | 'command';
  label: string;
  command?: string;
  output?: string;
  data?: Record<string, unknown>;
}

export interface FindTargetsInput {
  cwd: string;
  mode: Mode;
  base: string;
  head: string;
  maxFindings?: number;
}

export interface FindTargetsResult {
  findings: RefactorFinding[];
  evidence: RefactorEvidence[];
}

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const DUPLICATE_HELPERS = new Set([
  'sleep',
  'delay',
  'retry',
  'chunk',
  'groupBy',
  'uniqBy',
  'safeJsonParse',
  'mapWithConcurrency',
  'toCamelCase',
  'toSnakeCase',
]);

let findingCounter = 0;

function nextFindingId(prefix: string): string {
  findingCounter += 1;
  return `${prefix}-${String(findingCounter).padStart(4, '0')}`;
}

async function runCommand(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(),
    };
  }
}

function getPackageNameFromRelative(relPath: string): string | undefined {
  const normalized = relPath.split(path.sep).join('/');
  const match = normalized.match(/^packages\/([^/]+)\//);
  if (!match) return undefined;
  return match[1];
}

function lineFromIndex(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

async function listTrackedCodeFiles(cwd: string): Promise<string[]> {
  const result = await runCommand(cwd, 'git', ['ls-files']);
  if (result.code !== 0) return [];
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) =>
      CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
    );
}

async function listChangedCodeFiles(
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> {
  const result = await runCommand(cwd, 'git', [
    'diff',
    '--name-only',
    `${base}...${head}`,
  ]);
  if (result.code !== 0) return [];
  return result.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) =>
      CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase()),
    );
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function createFinding(
  findings: RefactorFinding[],
  maxFindings: number,
  finding: Omit<RefactorFinding, 'id'>,
): void {
  if (findings.length >= maxFindings) return;
  findings.push({
    id: nextFindingId(finding.category),
    ...finding,
  });
}

function dedupeFindings(findings: RefactorFinding[]): RefactorFinding[] {
  const seen = new Set<string>();
  const deduped: RefactorFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.category,
      finding.file ?? '',
      finding.line ?? '',
      finding.details,
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

export async function findRefactorTargets(
  input: FindTargetsInput,
): Promise<FindTargetsResult> {
  findingCounter = 0;

  const maxFindings = input.maxFindings ?? 400;
  const files =
    input.mode === 'on-demand'
      ? await listChangedCodeFiles(input.cwd, input.base, input.head)
      : await listTrackedCodeFiles(input.cwd);

  const findings: RefactorFinding[] = [];
  const evidence: RefactorEvidence[] = [];
  const helperIndex = new Map<string, string[]>();

  evidence.push({
    type: 'analysis',
    label: 'target-file-scan',
    data: {
      mode: input.mode,
      filesConsidered: files.length,
    },
  });

  for (const relPath of files) {
    const absPath = path.join(input.cwd, relPath);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      continue;
    }

    const packageName = getPackageNameFromRelative(relPath);

    for (const importMatch of content.matchAll(
      /^[ \t]*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/gm,
    )) {
      const specifier = importMatch[1];
      const line = lineFromIndex(content, importMatch.index ?? 0);

      if (/^@deepagents\/[^/]+\/src(?:\/|$)/.test(specifier)) {
        createFinding(findings, maxFindings, {
          title: 'Boundary bypass via deep source import',
          category: 'boundaries',
          principle: 'boundaries',
          severity: 'medium',
          packageName,
          file: normalizePath(relPath),
          line,
          details: `Import path "${specifier}" bypasses package boundary via /src/.`,
          suggestedFix:
            'Replace deep source import with package public entrypoint.',
        });
      }

      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(absPath), specifier);
        const normalized = normalizePath(path.relative(input.cwd, resolved));
        const targetPackage = getPackageNameFromRelative(normalized);

        if (packageName && targetPackage && targetPackage !== packageName) {
          createFinding(findings, maxFindings, {
            title: 'Cross-package relative import',
            category: 'boundaries',
            principle: 'boundaries',
            severity: 'high',
            packageName,
            file: normalizePath(relPath),
            line,
            details: `Relative import crosses package boundary into ${targetPackage}: "${specifier}".`,
            suggestedFix: `Depend on @deepagents/${targetPackage} public exports instead of relative source traversal.`,
          });
        }
      }
    }

    for (const castMatch of content.matchAll(/\bas any\b/g)) {
      createFinding(findings, maxFindings, {
        title: 'Unsafe cast using any',
        category: 'typing',
        principle: 'typing',
        severity: 'medium',
        packageName,
        file: normalizePath(relPath),
        line: lineFromIndex(content, castMatch.index ?? 0),
        details: 'Found unsafe cast with `as any`.',
        suggestedFix:
          'Use `unknown` plus explicit narrowing/validation at the boundary.',
      });
    }

    for (const typedAnyMatch of content.matchAll(/:\s*any\b/g)) {
      createFinding(findings, maxFindings, {
        title: 'Loose any type annotation',
        category: 'typing',
        principle: 'typing',
        severity: 'medium',
        packageName,
        file: normalizePath(relPath),
        line: lineFromIndex(content, typedAnyMatch.index ?? 0),
        details: 'Found `: any` annotation that weakens boundary typing.',
        suggestedFix:
          'Replace with explicit type or `unknown` and narrow safely.',
      });
    }

    for (const recordAnyMatch of content.matchAll(
      /Record<\s*string\s*,\s*any\s*>/g,
    )) {
      createFinding(findings, maxFindings, {
        title: 'Record<string, unknown> boundary shape guess',
        category: 'typing',
        principle: 'typing',
        severity: 'medium',
        packageName,
        file: normalizePath(relPath),
        line: lineFromIndex(content, recordAnyMatch.index ?? 0),
        details:
          'Found `Record<string, unknown>` which allows unvalidated shape assumptions.',
        suggestedFix:
          'Prefer `Record<string, unknown>` and parse/validate before access.',
      });
    }

    for (const parseMatch of content.matchAll(/JSON\.parse\(/g)) {
      createFinding(findings, maxFindings, {
        title: 'JSON.parse boundary requires explicit validation',
        category: 'typing',
        principle: 'typing',
        severity: 'low',
        packageName,
        file: normalizePath(relPath),
        line: lineFromIndex(content, parseMatch.index ?? 0),
        details:
          'Raw JSON.parse output should be narrowed/validated before use.',
        suggestedFix:
          'Parse to `unknown` and validate with schema or type guard.',
      });
    }

    for (const helperMatch of content.matchAll(
      /(?:^|\n)\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    )) {
      const helperName = helperMatch[1];
      if (!DUPLICATE_HELPERS.has(helperName)) continue;
      const list = helperIndex.get(helperName) ?? [];
      list.push(normalizePath(relPath));
      helperIndex.set(helperName, list);
    }

    for (const helperMatch of content.matchAll(
      /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    )) {
      const helperName = helperMatch[1];
      if (!DUPLICATE_HELPERS.has(helperName)) continue;
      const list = helperIndex.get(helperName) ?? [];
      list.push(normalizePath(relPath));
      helperIndex.set(helperName, list);
    }
  }

  for (const [helperName, locations] of helperIndex) {
    const uniqueLocations = [...new Set(locations)];
    if (uniqueLocations.length < 2) continue;

    createFinding(findings, maxFindings, {
      title: `Duplicate helper pattern: ${helperName}`,
      category: 'reuse',
      principle: 'reuse',
      severity: 'medium',
      details: `Helper "${helperName}" appears in multiple files: ${uniqueLocations.join(', ')}`,
      suggestedFix:
        'Extract into a shared utility package/module and replace duplicated implementations.',
    });
  }

  evidence.push({
    type: 'analysis',
    label: 'findings-summary',
    data: {
      boundaries: findings.filter((item) => item.category === 'boundaries')
        .length,
      reuse: findings.filter((item) => item.category === 'reuse').length,
      typing: findings.filter((item) => item.category === 'typing').length,
    },
  });

  return {
    findings: dedupeFindings(findings),
    evidence,
  };
}
