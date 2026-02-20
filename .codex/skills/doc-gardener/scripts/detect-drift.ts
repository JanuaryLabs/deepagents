import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Mode = 'on-demand' | 'scheduled';

export interface SkillFinding {
  id: string;
  title: string;
  category: 'api-drift' | 'behavior-drift' | 'docs-integrity';
  severity: 'low' | 'medium' | 'high';
  domain: string;
  packageName?: string;
  file?: string;
  details: string;
  suggestedFix?: string;
}

export interface SkillEvidence {
  type: 'command' | 'analysis' | 'file';
  label: string;
  command?: string;
  file?: string;
  output?: string;
  data?: Record<string, unknown>;
}

export interface DetectDriftInput {
  cwd: string;
  mode: Mode;
  base: string;
  head: string;
  skipBehaviorCheck?: boolean;
}

export interface DetectDriftResult {
  findings: SkillFinding[];
  unresolved: SkillFinding[];
  evidence: SkillEvidence[];
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.nx',
  'dist',
  'build',
  '.next',
]);
const LINK_REGEX = /\[[^\]]+\]\(([^)]+)\)/g;
const HEADING_REGEX = /^#{1,6}\s+(.+)$/gm;

let findingCounter = 0;

function nextFindingId(prefix: string): string {
  findingCounter += 1;
  return `${prefix}-${String(findingCounter).padStart(4, '0')}`;
}

function slugifyHeading(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+={}\[\]|\\:;"'<>,.?/]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function anchorScore(source: string, candidate: string): number {
  if (!source || !candidate) return 0;
  if (source === candidate) return 1;
  const a = source.replace(/-/g, '');
  const b = candidate.replace(/-/g, '');
  if (a === b) return 0.98;
  if (a.includes(b) || b.includes(a)) return 0.9;
  let prefix = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) break;
    prefix += 1;
  }
  return prefix / Math.max(a.length, b.length);
}

function pickClosestAnchor(
  anchor: string,
  headings: string[],
): string | undefined {
  const normalized = slugifyHeading(anchor);
  let best: { slug: string; score: number } | null = null;
  for (const heading of headings) {
    const score = anchorScore(normalized, heading);
    if (!best || score > best.score) {
      best = { slug: heading, score };
    }
  }
  if (!best || best.score < 0.6) return undefined;
  return best.slug;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(
  root: string,
  extensions: Set<string>,
  out: string[] = [],
): Promise<string[]> {
  if (!(await pathExists(root))) return out;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      if (!['.md', '.mdx'].includes(path.extname(entry.name))) continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await listFilesRecursive(fullPath, extensions, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
  return out;
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const match of content.matchAll(HEADING_REGEX)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    headings.push(slugifyHeading(raw));
  }
  return headings;
}

function extractExportNames(source: string): Set<string> {
  const names = new Set<string>();

  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    const block = match[1] ?? '';
    for (const piece of block.split(',')) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const [left] = trimmed.split(/\s+as\s+/i);
      const candidate = left.trim();
      if (candidate) names.add(candidate);
    }
  }

  return names;
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

async function gitDiffFiles(
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
    .filter(Boolean);
}

function inferPackageFromPath(
  filePath: string,
  cwd: string,
): string | undefined {
  const rel = path.relative(cwd, filePath).split(path.sep);
  const docsIdx = rel.indexOf('docs');
  if (rel[0] === 'packages' && rel.length >= 2) return rel[1];
  if (docsIdx >= 0 && rel[docsIdx - 1] === 'app' && rel[docsIdx + 1])
    return rel[docsIdx + 1];
  if (rel[0] === 'apps' && rel[1] === 'docs' && rel[3] === 'docs' && rel[4])
    return rel[4];
  return undefined;
}

async function resolvePathCandidates(basePath: string): Promise<string | null> {
  const ext = path.extname(basePath);
  const candidates = ext
    ? [basePath]
    : [
        basePath,
        `${basePath}.mdx`,
        `${basePath}.md`,
        path.join(basePath, 'index.mdx'),
        path.join(basePath, 'index.md'),
      ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function isSectionLabel(page: string): boolean {
  return page.startsWith('---') && page.endsWith('---');
}

async function collectMetaPageCandidates(directory: string): Promise<string[]> {
  const pages = new Set<string>();
  const entries = await fs.readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.mdx' || ext === '.md') {
        pages.add(path.basename(entry.name, ext));
      }
      continue;
    }

    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const indexMdx = path.join(directory, entry.name, 'index.mdx');
    const indexMd = path.join(directory, entry.name, 'index.md');
    if ((await pathExists(indexMdx)) || (await pathExists(indexMd))) {
      pages.add(entry.name);
    }
  }

  return [...pages];
}

async function collectScopeFiles(cwd: string): Promise<string[]> {
  const docsRoot = path.join(cwd, 'apps', 'docs', 'app', 'docs');
  const files = await listFilesRecursive(docsRoot, new Set(['.md', '.mdx']));

  const packageRoot = path.join(cwd, 'packages');
  if (await pathExists(packageRoot)) {
    const packageDirs = await fs.readdir(packageRoot, { withFileTypes: true });
    for (const entry of packageDirs) {
      if (!entry.isDirectory()) continue;
      const readmePath = path.join(packageRoot, entry.name, 'README.md');
      if (await pathExists(readmePath)) files.push(readmePath);
    }
  }

  for (const rootFile of ['AGENTS.md', 'README.md']) {
    const fullPath = path.join(cwd, rootFile);
    if (await pathExists(fullPath)) files.push(fullPath);
  }

  return files;
}

async function detectApiDrift(
  input: DetectDriftInput,
  findings: SkillFinding[],
  evidence: SkillEvidence[],
): Promise<void> {
  const packagesRoot = path.join(input.cwd, 'packages');
  if (!(await pathExists(packagesRoot))) return;

  const changedFiles =
    input.mode === 'on-demand'
      ? await gitDiffFiles(input.cwd, input.base, input.head)
      : [];
  const changedPackages = new Set(
    changedFiles
      .filter((file) => file.startsWith('packages/'))
      .map((file) => file.split('/')[1])
      .filter(Boolean),
  );

  const dirs = await fs.readdir(packagesRoot, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (
      input.mode === 'on-demand' &&
      changedPackages.size > 0 &&
      !changedPackages.has(dir.name)
    ) {
      continue;
    }

    const indexPath = path.join(packagesRoot, dir.name, 'src', 'index.ts');
    const indexSource = await readFileIfExists(indexPath);
    if (!indexSource) continue;

    const exports = [...extractExportNames(indexSource)].filter(
      (name) => name.length > 1,
    );
    if (exports.length === 0) continue;

    const docsPath = path.join(
      input.cwd,
      'apps',
      'docs',
      'app',
      'docs',
      dir.name,
    );
    const docsFiles = await listFilesRecursive(
      docsPath,
      new Set(['.md', '.mdx']),
    );
    const readme = await readFileIfExists(
      path.join(packagesRoot, dir.name, 'README.md'),
    );

    const docsBlobPieces: string[] = [];
    for (const filePath of docsFiles) {
      const content = await readFileIfExists(filePath);
      if (content) docsBlobPieces.push(content);
    }
    if (readme) docsBlobPieces.push(readme);

    const docsBlob = docsBlobPieces.join('\n').toLowerCase();
    const missing = exports.filter(
      (name) => !new RegExp(`\\b${name.toLowerCase()}\\b`).test(docsBlob),
    );

    evidence.push({
      type: 'analysis',
      label: `api-drift-scan:${dir.name}`,
      data: {
        package: dir.name,
        exportedCount: exports.length,
        docsFilesScanned: docsFiles.length,
        missingCount: missing.length,
      },
    });

    if (missing.length === 0) continue;

    findings.push({
      id: nextFindingId('api'),
      title: `Missing exported API coverage for ${dir.name}`,
      category: 'api-drift',
      severity: 'medium',
      domain: dir.name,
      packageName: dir.name,
      file: path.relative(input.cwd, indexPath),
      details: `Found ${missing.length} exported symbol(s) not referenced by package docs/README: ${missing.join(', ')}`,
      suggestedFix: `Update docs under apps/docs/app/docs/${dir.name}/ and packages/${dir.name}/README.md with these exports and examples.`,
    });
  }
}

async function detectBehaviorDrift(
  input: DetectDriftInput,
  findings: SkillFinding[],
  evidence: SkillEvidence[],
): Promise<void> {
  if (input.skipBehaviorCheck) {
    evidence.push({
      type: 'analysis',
      label: 'behavior-drift-scan-skipped',
      data: { reason: 'skipBehaviorCheck=true' },
    });
    return;
  }

  const args =
    input.mode === 'on-demand'
      ? [
          'nx',
          'affected',
          '-t',
          'test',
          `--base=${input.base}`,
          `--head=${input.head}`,
          '--outputStyle=static',
        ]
      : ['nx', 'run-many', '-t', 'test', '--outputStyle=static'];

  const result = await runCommand(input.cwd, 'npx', args);
  evidence.push({
    type: 'command',
    label: 'behavior-gate',
    command: `npx ${args.join(' ')}`,
    output: result.output.slice(0, 8000),
  });

  if (result.code === 0) return;

  findings.push({
    id: nextFindingId('behavior'),
    title: 'Behavior drift signal from failing test gate',
    category: 'behavior-drift',
    severity: 'high',
    domain: 'workspace',
    details:
      'Test gate failed, indicating behavior drift risk between documentation and runtime behavior.',
    suggestedFix:
      'Investigate failing tests, align docs with current behavior, and rerun test gates.',
  });
}

async function detectMetaIntegrity(
  input: DetectDriftInput,
  findings: SkillFinding[],
  evidence: SkillEvidence[],
): Promise<void> {
  const docsRoot = path.join(input.cwd, 'apps', 'docs', 'app', 'docs');
  if (!(await pathExists(docsRoot))) return;

  const metaFiles = await listFilesRecursive(docsRoot, new Set(['.json']));
  for (const metaPath of metaFiles.filter(
    (file) => path.basename(file) === 'meta.json',
  )) {
    const raw = await readFileIfExists(metaPath);
    if (!raw) continue;

    let parsed: { pages?: string[] };
    try {
      parsed = JSON.parse(raw) as { pages?: string[] };
    } catch {
      findings.push({
        id: nextFindingId('meta'),
        title: 'Invalid meta.json',
        category: 'docs-integrity',
        severity: 'high',
        domain: inferPackageFromPath(metaPath, input.cwd) ?? 'docs',
        file: path.relative(input.cwd, metaPath),
        details: 'meta.json is not valid JSON.',
        suggestedFix: 'Repair meta.json syntax and rerun doc-gardener.',
      });
      continue;
    }

    const hasExplicitPages = Array.isArray(parsed.pages);
    const pages = hasExplicitPages ? parsed.pages : [];
    const directory = path.dirname(metaPath);
    const docsInDir = await collectMetaPageCandidates(directory);
    const docsSet = new Set(docsInDir);

    if (!hasExplicitPages) {
      evidence.push({
        type: 'analysis',
        label: `meta-integrity:${path.relative(input.cwd, metaPath)}`,
        data: {
          pagesCount: 0,
          docsInDirCount: docsInDir.length,
          missingCount: 0,
          implicitNavigation: true,
        },
      });
      continue;
    }

    let missingCount = 0;
    for (const page of pages) {
      if (isSectionLabel(page)) continue;
      if (!docsSet.has(page)) {
        missingCount += 1;
        findings.push({
          id: nextFindingId('meta-missing'),
          title: `meta.json references missing page: ${page}`,
          category: 'docs-integrity',
          severity: 'high',
          domain: inferPackageFromPath(metaPath, input.cwd) ?? 'docs',
          file: path.relative(input.cwd, metaPath),
          details: `Entry "${page}" in meta.json does not map to an existing .md/.mdx file.`,
          suggestedFix:
            'Remove stale page entry or create the missing document file.',
        });
      }
    }

    const referencedPages = new Set(
      pages.filter((page) => !isSectionLabel(page)),
    );
    for (const doc of docsInDir) {
      if (!referencedPages.has(doc)) {
        findings.push({
          id: nextFindingId('meta-orphan'),
          title: `Orphan doc not listed in meta.json: ${doc}`,
          category: 'docs-integrity',
          severity: 'medium',
          domain: inferPackageFromPath(metaPath, input.cwd) ?? 'docs',
          file: path.relative(input.cwd, path.join(directory, `${doc}.mdx`)),
          details: `${doc} exists next to meta.json but is not listed in pages[].`,
          suggestedFix:
            'Add the page to meta.json pages[] or remove the orphan doc.',
        });
      }
    }

    evidence.push({
      type: 'analysis',
      label: `meta-integrity:${path.relative(input.cwd, metaPath)}`,
      data: {
        pagesCount: pages.length,
        docsInDirCount: docsInDir.length,
        missingCount,
      },
    });
  }
}

async function detectLinkIntegrity(
  input: DetectDriftInput,
  findings: SkillFinding[],
  evidence: SkillEvidence[],
): Promise<void> {
  const files = await collectScopeFiles(input.cwd);

  for (const filePath of files) {
    const content = await readFileIfExists(filePath);
    if (!content) continue;

    const headings = extractHeadings(content);
    const headingSet = new Set(headings);

    for (const match of content.matchAll(LINK_REGEX)) {
      const target = (match[1] ?? '').trim();
      if (!target) continue;
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue;

      const [rawPath, rawAnchor] = target.split('#');

      if (!rawPath) {
        const anchor = (rawAnchor ?? '').trim();
        if (!anchor) continue;
        const normalized = slugifyHeading(anchor);
        if (headingSet.has(normalized)) continue;

        const suggestion = pickClosestAnchor(anchor, headings);
        findings.push({
          id: nextFindingId('anchor'),
          title: 'Broken internal anchor',
          category: 'docs-integrity',
          severity: 'medium',
          domain: inferPackageFromPath(filePath, input.cwd) ?? 'docs',
          file: path.relative(input.cwd, filePath),
          details: `Anchor #${anchor} does not exist in this document.`,
          suggestedFix: suggestion
            ? `Use #${suggestion}`
            : 'Update link to an existing heading anchor.',
        });
        continue;
      }

      let resolvedBase: string;
      if (rawPath.startsWith('/docs/')) {
        resolvedBase = path.join(input.cwd, 'apps', 'docs', 'app', rawPath);
      } else if (rawPath.startsWith('/')) {
        resolvedBase = path.join(input.cwd, rawPath.slice(1));
      } else {
        resolvedBase = path.resolve(path.dirname(filePath), rawPath);
      }

      const resolved = await resolvePathCandidates(resolvedBase);
      if (!resolved) {
        findings.push({
          id: nextFindingId('link'),
          title: 'Broken document link',
          category: 'docs-integrity',
          severity: 'medium',
          domain: inferPackageFromPath(filePath, input.cwd) ?? 'docs',
          file: path.relative(input.cwd, filePath),
          details: `Link target not found: ${target}`,
          suggestedFix: 'Correct path or add the target document.',
        });
        continue;
      }

      if (rawAnchor) {
        const targetContent = await readFileIfExists(resolved);
        if (!targetContent) continue;
        const targetHeadings = extractHeadings(targetContent);
        const normalized = slugifyHeading(rawAnchor);
        if (!targetHeadings.includes(normalized)) {
          const suggestion = pickClosestAnchor(rawAnchor, targetHeadings);
          findings.push({
            id: nextFindingId('link-anchor'),
            title: 'Broken link anchor in target document',
            category: 'docs-integrity',
            severity: 'medium',
            domain: inferPackageFromPath(filePath, input.cwd) ?? 'docs',
            file: path.relative(input.cwd, filePath),
            details: `Anchor #${rawAnchor} is missing in ${path.relative(input.cwd, resolved)}.`,
            suggestedFix: suggestion
              ? `Use #${suggestion}`
              : 'Update the anchor to a valid target heading.',
          });
        }
      }
    }

    evidence.push({
      type: 'analysis',
      label: `link-scan:${path.relative(input.cwd, filePath)}`,
      data: { headings: headings.length },
    });
  }
}

function dedupeFindings(findings: SkillFinding[]): SkillFinding[] {
  const seen = new Set<string>();
  const deduped: SkillFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.category,
      finding.file ?? '',
      finding.title,
      finding.details,
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

export async function detectDrift(
  input: DetectDriftInput,
): Promise<DetectDriftResult> {
  findingCounter = 0;
  const findings: SkillFinding[] = [];
  const evidence: SkillEvidence[] = [];

  await detectApiDrift(input, findings, evidence);
  await detectBehaviorDrift(input, findings, evidence);
  await detectMetaIntegrity(input, findings, evidence);
  await detectLinkIntegrity(input, findings, evidence);

  const deduped = dedupeFindings(findings);
  const unresolved = deduped.filter(
    (finding) =>
      finding.category === 'api-drift' || finding.category === 'behavior-drift',
  );

  return {
    findings: deduped,
    unresolved,
    evidence,
  };
}
