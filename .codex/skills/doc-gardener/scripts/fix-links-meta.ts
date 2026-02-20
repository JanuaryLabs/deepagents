import fs from 'node:fs';
import path from 'node:path';

import type { SkillFinding } from './detect-drift.ts';

const LINK_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;
const HEADING_REGEX = /^#{1,6}\s+(.+)$/gm;

export interface FixRecord {
  type: 'link' | 'anchor' | 'meta';
  file: string;
  before: string;
  after: string;
  note: string;
}

export interface FixLinksMetaInput {
  cwd: string;
  findings: SkillFinding[];
}

export interface FixLinksMetaResult {
  fixesApplied: FixRecord[];
}

function slugifyHeading(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[`~!@#$%^&*()+={}\[\]|\\:;"'<>,.?/]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
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

function scoreAnchor(source: string, candidate: string): number {
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
  let best: { value: string; score: number } | null = null;
  for (const heading of headings) {
    const score = scoreAnchor(normalized, heading);
    if (!best || score > best.score) {
      best = { value: heading, score };
    }
  }
  if (!best || best.score < 0.6) return undefined;
  return best.value;
}

function listFilesRecursive(
  root: string,
  extensions: Set<string>,
  out: string[] = [],
): string[] {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === '.nx' ||
      entry.name === 'dist'
    ) {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(fullPath, extensions, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions.has(path.extname(entry.name).toLowerCase())) {
      out.push(fullPath);
    }
  }
  return out;
}

function resolveCandidate(absPath: string): string | null {
  const ext = path.extname(absPath);
  const candidates = ext
    ? [absPath]
    : [
        absPath,
        `${absPath}.mdx`,
        `${absPath}.md`,
        path.join(absPath, 'index.mdx'),
        path.join(absPath, 'index.md'),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function isSectionLabel(page: string): boolean {
  return page.startsWith('---') && page.endsWith('---');
}

function collectMetaPageCandidates(directory: string): string[] {
  const pages = new Set<string>();
  const entries = fs.readdirSync(directory, { withFileTypes: true });

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
    if (fs.existsSync(indexMdx) || fs.existsSync(indexMd)) {
      pages.add(entry.name);
    }
  }

  return [...pages];
}

function toDocsRoute(cwd: string, absolutePath: string): string {
  const docsRoot = path.join(cwd, 'apps', 'docs', 'app', 'docs');
  if (!absolutePath.startsWith(docsRoot)) {
    return `/${path.relative(cwd, absolutePath).split(path.sep).join('/')}`;
  }
  const rel = path.relative(docsRoot, absolutePath).split(path.sep).join('/');
  const noExt = rel.replace(/\.(mdx|md)$/i, '').replace(/\/index$/i, '');
  return `/docs/${noExt}`;
}

function toRelativeLink(fromFile: string, absolutePath: string): string {
  const rel = path
    .relative(path.dirname(fromFile), absolutePath)
    .split(path.sep)
    .join('/');
  if (rel.startsWith('.')) return rel;
  return `./${rel}`;
}

function proposePathFix(
  cwd: string,
  currentFile: string,
  rawPath: string,
): string | null {
  const target = rawPath.trim();
  if (!target) return null;

  let basePath: string;
  if (target.startsWith('/docs/')) {
    basePath = path.join(cwd, 'apps', 'docs', 'app', target);
  } else if (target.startsWith('/')) {
    basePath = path.join(cwd, target.slice(1));
  } else {
    basePath = path.resolve(path.dirname(currentFile), target);
  }

  const resolved = resolveCandidate(basePath);
  if (!resolved) return null;

  if (target.startsWith('/docs/')) {
    return toDocsRoute(cwd, resolved);
  }
  if (target.startsWith('/')) {
    return `/${path.relative(cwd, resolved).split(path.sep).join('/')}`;
  }
  return toRelativeLink(currentFile, resolved);
}

function fixMetaFiles(cwd: string, fixesApplied: FixRecord[]): void {
  const docsRoot = path.join(cwd, 'apps', 'docs', 'app', 'docs');
  const metaFiles = listFilesRecursive(docsRoot, new Set(['.json'])).filter(
    (filePath) => path.basename(filePath) === 'meta.json',
  );

  for (const metaPath of metaFiles) {
    const raw = fs.readFileSync(metaPath, 'utf8');
    let meta: { pages?: string[] };
    try {
      meta = JSON.parse(raw) as { pages?: string[] };
    } catch {
      continue;
    }

    if (!Array.isArray(meta.pages)) continue;

    const pages = meta.pages;
    const dir = path.dirname(metaPath);
    const docs = collectMetaPageCandidates(dir);
    const docsSet = new Set(docs);
    const referenced = new Set<string>();
    const finalPages: string[] = [];

    for (const page of pages) {
      if (isSectionLabel(page)) {
        finalPages.push(page);
        continue;
      }
      if (!docsSet.has(page)) {
        continue;
      }
      finalPages.push(page);
      referenced.add(page);
    }

    const missingInMeta = docs.filter((doc) => !referenced.has(doc));
    for (const page of missingInMeta.sort()) {
      finalPages.push(page);
    }

    if (JSON.stringify(finalPages) === JSON.stringify(pages)) continue;

    meta.pages = finalPages;
    const after = JSON.stringify(meta, null, 2) + '\n';
    fs.writeFileSync(metaPath, after, 'utf8');

    fixesApplied.push({
      type: 'meta',
      file: path.relative(cwd, metaPath),
      before: pages.join(', '),
      after: finalPages.join(', '),
      note: 'Reconciled meta.json entries with existing docs files in directory.',
    });
  }
}

function fixLinksAndAnchors(cwd: string, fixesApplied: FixRecord[]): void {
  const docsRoot = path.join(cwd, 'apps', 'docs', 'app', 'docs');
  const docFiles = listFilesRecursive(docsRoot, new Set(['.md', '.mdx']));

  const rootDocs = [
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, 'README.md'),
  ].filter((filePath) => fs.existsSync(filePath));
  const packageReadmes = listFilesRecursive(
    path.join(cwd, 'packages'),
    new Set(['.md']),
  ).filter((filePath) => path.basename(filePath).toLowerCase() === 'readme.md');

  for (const filePath of [...docFiles, ...rootDocs, ...packageReadmes]) {
    const original = fs.readFileSync(filePath, 'utf8');
    const headings = extractHeadings(original);

    let changed = false;
    const updated = original.replace(
      LINK_REGEX,
      (fullMatch, label, rawTarget) => {
        const target = String(rawTarget ?? '').trim();
        if (!target || /^(https?:|mailto:|tel:)/i.test(target))
          return fullMatch;

        const [pathPart, anchorPart] = target.split('#');

        if (!pathPart) {
          const anchor = (anchorPart ?? '').trim();
          if (!anchor) return fullMatch;
          const normalized = slugifyHeading(anchor);
          if (headings.includes(normalized)) return fullMatch;

          const replacementAnchor = pickClosestAnchor(anchor, headings);
          if (!replacementAnchor) return fullMatch;

          changed = true;
          const nextTarget = `#${replacementAnchor}`;
          fixesApplied.push({
            type: 'anchor',
            file: path.relative(cwd, filePath),
            before: target,
            after: nextTarget,
            note: 'Updated internal anchor to closest existing heading.',
          });

          return `[${label}](${nextTarget})`;
        }

        let nextPath = pathPart;
        const fixedPath = proposePathFix(cwd, filePath, pathPart);
        if (fixedPath) {
          nextPath = fixedPath;
        }

        let nextAnchor = anchorPart;
        if (anchorPart) {
          let targetFile: string | null = null;
          if (nextPath.startsWith('/docs/')) {
            targetFile = resolveCandidate(
              path.join(cwd, 'apps', 'docs', 'app', nextPath),
            );
          } else if (nextPath.startsWith('/')) {
            targetFile = resolveCandidate(path.join(cwd, nextPath.slice(1)));
          } else {
            targetFile = resolveCandidate(
              path.resolve(path.dirname(filePath), nextPath),
            );
          }

          if (targetFile && fs.existsSync(targetFile)) {
            const targetContent = fs.readFileSync(targetFile, 'utf8');
            const targetHeadings = extractHeadings(targetContent);
            const normalizedAnchor = slugifyHeading(anchorPart);
            if (!targetHeadings.includes(normalizedAnchor)) {
              const replacementAnchor = pickClosestAnchor(
                anchorPart,
                targetHeadings,
              );
              if (replacementAnchor) nextAnchor = replacementAnchor;
            }
          }
        }

        const rebuilt = nextAnchor ? `${nextPath}#${nextAnchor}` : nextPath;
        if (rebuilt === target) return fullMatch;

        changed = true;
        fixesApplied.push({
          type: anchorPart ? 'anchor' : 'link',
          file: path.relative(cwd, filePath),
          before: target,
          after: rebuilt,
          note: 'Updated link/anchor to resolvable deterministic target.',
        });

        return `[${label}](${rebuilt})`;
      },
    );

    if (!changed || updated === original) continue;
    fs.writeFileSync(filePath, updated, 'utf8');
  }
}

export async function fixLinksAndMeta(
  input: FixLinksMetaInput,
): Promise<FixLinksMetaResult> {
  const fixesApplied: FixRecord[] = [];

  // Keep findings parameter in signature for future strategy-specific fix selection.
  void input.findings;

  fixMetaFiles(input.cwd, fixesApplied);
  fixLinksAndAnchors(input.cwd, fixesApplied);

  return { fixesApplied };
}
